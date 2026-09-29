import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '@balsa/core/memory';
import type { StoredMessage, StoredThread, WorkingMemoryStore } from '@balsa/core/memory';
import type { ModelTextPart } from '@balsa/core/model';
import { captureRejection } from './helpers/assertions.js';

/**
 * 内存默认 MemoryStore 的行为语义(#38):只经 port 接口断言(不触碰内部 Map),它就是
 * adapter 作者的语义参考实现(docs/architecture/storage.md)。钉住的语义:时间戳归调用方
 * (store 原样持久化);listThreads 按 updatedAt 倒序(同刻按 id 倒序),limit 锚定最新端;
 * before 游标 = 严格早于参照项,悬空游标显式报错;limit 必须是正整数;读写给深拷贝,
 * 存储状态只能经 port 改变(与序列化后端一致)。
 */

let threadCounter = 0;
function makeThread(partial: Partial<StoredThread> & { id: string }): StoredThread {
  threadCounter += 1;
  return {
    resourceId: 'user-1',
    createdAt: new Date(1_700_000_000_000 + threadCounter * 1000),
    updatedAt: new Date(1_700_000_000_000 + threadCounter * 1000),
    ...partial,
  };
}

async function seedThreads(
  store: WorkingMemoryStore,
  threads: StoredThread[],
): Promise<void> {
  for (const thread of threads) await store.saveThread(thread);
}

describe('线程读写', () => {
  it('saveThread 创建后可经 getThreadById 读回;未知 id 返回 null', async () => {
    const store = createInMemoryStore();
    await expect(store.getThreadById('nope')).resolves.toBeNull();

    const thread = makeThread({ id: 'thread-1', title: 'first' });
    await store.saveThread(thread);

    const got = await store.getThreadById('thread-1');
    expect(got).toEqual(thread);
  });

  it('saveThread 是 upsert:同 id 全量替换,时间戳原样持久化(归调用方维护)', async () => {
    const store = createInMemoryStore();
    const created = makeThread({ id: 'thread-1', title: 'before' });
    await store.saveThread(created);

    const updated: StoredThread = {
      ...created,
      title: 'after',
      updatedAt: new Date(created.updatedAt.getTime() + 60_000),
    };
    await store.saveThread(updated);

    const got = await store.getThreadById('thread-1');
    expect(got?.title).toBe('after');
    expect(got?.createdAt).toEqual(created.createdAt);
    expect(got?.updatedAt).toEqual(updated.updatedAt);
  });
});

describe('listThreads', () => {
  it('只列指定 resourceId 的 thread,默认 updatedAt 倒序(最新活跃在前)', async () => {
    const store = createInMemoryStore();
    const base = 1_700_000_000_000;
    await seedThreads(store, [
      makeThread({ id: 'old', resourceId: 'user-1', updatedAt: new Date(base + 1_000) }),
      makeThread({ id: 'new', resourceId: 'user-1', updatedAt: new Date(base + 3_000) }),
      makeThread({ id: 'mid', resourceId: 'user-1', updatedAt: new Date(base + 2_000) }),
      makeThread({ id: 'other', resourceId: 'user-2', updatedAt: new Date(base + 9_000) }),
    ]);

    const listed = await store.listThreads({ resourceId: 'user-1' });
    expect(listed.map((thread) => thread.id)).toEqual(['new', 'mid', 'old']);
  });

  it('limit 锚定最新端;before 游标取严格早于参照项的一页,可翻完整个列表', async () => {
    const store = createInMemoryStore();
    const base = 1_700_000_000_000;
    await seedThreads(
      store,
      ['t1', 't2', 't3', 't4', 't5'].map((id, index) =>
        makeThread({ id, updatedAt: new Date(base + (index + 1) * 1_000) }),
      ),
    );

    const page1 = await store.listThreads({ resourceId: 'user-1', limit: 2 });
    expect(page1.map((thread) => thread.id)).toEqual(['t5', 't4']);

    const page2 = await store.listThreads({ resourceId: 'user-1', limit: 2, before: 't4' });
    expect(page2.map((thread) => thread.id)).toEqual(['t3', 't2']);

    const page3 = await store.listThreads({ resourceId: 'user-1', limit: 2, before: 't2' });
    expect(page3.map((thread) => thread.id)).toEqual(['t1']);
  });

  it('悬空 before 游标(不存在或属于别的 resource)显式报错;limit 非正整数显式报错', async () => {
    const store = createInMemoryStore();
    await store.saveThread(makeThread({ id: 'thread-1', resourceId: 'user-1' }));
    await store.saveThread(makeThread({ id: 'thread-2', resourceId: 'user-2' }));

    const missing = await captureRejection(() =>
      store.listThreads({ resourceId: 'user-1', before: 'nope' }),
    );
    expect(missing.message).toContain('nope');

    const foreign = await captureRejection(() =>
      store.listThreads({ resourceId: 'user-1', before: 'thread-2' }),
    );
    expect(foreign.message).toContain('thread-2');

    const badLimit = await captureRejection(() =>
      store.listThreads({ resourceId: 'user-1', limit: 0 }),
    );
    expect(badLimit.message).toContain('limit');
  });
});

let messageCounter = 0;
function makeMessage(options: {
  id: string;
  threadId?: string;
  resourceId?: string;
  createdAt?: Date;
  content?: Array<ModelTextPart>;
}): StoredMessage {
  messageCounter += 1;
  return {
    id: options.id,
    threadId: options.threadId ?? 'thread-1',
    resourceId: options.resourceId ?? 'user-1',
    createdAt: options.createdAt ?? new Date(1_700_000_000_000 + messageCounter * 1000),
    role: 'user',
    content: options.content ?? [{ type: 'text', text: `message ${messageCounter}` }],
  };
}

describe('消息读写与窗口语义', () => {
  it('saveMessages 批量落库,listMessages 原样读回(消息格式即 ModelMessage + 信封)', async () => {
    const store = createInMemoryStore();
    const messages = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
    await store.saveMessages(messages);

    const listed = await store.listMessages({ threadId: 'thread-1', order: 'asc' });
    expect(listed).toEqual(messages);
    // 内容部分完整穿透(StoredMessage 可直接喂模型)
    expect(listed[0]?.content).toEqual([{ type: 'text', text: 'message 1' }]);
  });

  it('saveMessages 按 id upsert:重复 id 全量替换(消息不可变是上层纪律,store 不合并)', async () => {
    const store = createInMemoryStore();
    await store.saveMessages([makeMessage({ id: 'm1', createdAt: new Date(1_700_000_000_000) })]);

    const replacement = makeMessage({
      id: 'm1',
      content: [{ type: 'text', text: 'replaced' }],
      createdAt: new Date(1_700_000_000_000),
    });
    await store.saveMessages([replacement]);

    const listed = await store.listMessages({ threadId: 'thread-1' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.content).toEqual([{ type: 'text', text: 'replaced' }]);
  });

  it('默认 createdAt 倒序;limit 锚定最新端——限量永不返回最旧的 N 条', async () => {
    const store = createInMemoryStore();
    const base = 1_700_000_000_000;
    await store.saveMessages(
      ['m1', 'm2', 'm3', 'm4', 'm5'].map((id, index) =>
        makeMessage({ id, createdAt: new Date(base + (index + 1) * 1_000) }),
      ),
    );

    const all = await store.listMessages({ threadId: 'thread-1' });
    expect(all.map((message) => message.id)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);

    // recall 的窗口语义:limit + asc = 最新 N 条按时间正序(mastra 曾出"返回最旧 64 条"的 bug)
    const window = await store.listMessages({ threadId: 'thread-1', limit: 2, order: 'asc' });
    expect(window.map((message) => message.id)).toEqual(['m4', 'm5']);

    const windowDesc = await store.listMessages({ threadId: 'thread-1', limit: 2 });
    expect(windowDesc.map((message) => message.id)).toEqual(['m5', 'm4']);
  });

  it('before 游标向更旧翻页:严格早于参照消息,与 order 无关', async () => {
    const store = createInMemoryStore();
    const base = 1_700_000_000_000;
    await store.saveMessages(
      ['m1', 'm2', 'm3', 'm4', 'm5'].map((id, index) =>
        makeMessage({ id, createdAt: new Date(base + (index + 1) * 1_000) }),
      ),
    );

    const older = await store.listMessages({ threadId: 'thread-1', limit: 2, before: 'm3' });
    expect(older.map((message) => message.id)).toEqual(['m2', 'm1']);

    const olderAsc = await store.listMessages({
      threadId: 'thread-1',
      limit: 2,
      before: 'm3',
      order: 'asc',
    });
    expect(olderAsc.map((message) => message.id)).toEqual(['m1', 'm2']);
  });

  it('悬空 before 游标(不存在或属于别的 thread)显式报错;limit 非正整数显式报错', async () => {
    const store = createInMemoryStore();
    await store.saveMessages([makeMessage({ id: 'm1', threadId: 'thread-1' })]);
    await store.saveMessages([makeMessage({ id: 'm9', threadId: 'thread-2' })]);

    const missing = await captureRejection(() =>
      store.listMessages({ threadId: 'thread-1', before: 'nope' }),
    );
    expect(missing.message).toContain('nope');

    const foreign = await captureRejection(() =>
      store.listMessages({ threadId: 'thread-1', before: 'm9' }),
    );
    expect(foreign.message).toContain('m9');

    const badLimit = await captureRejection(() =>
      store.listMessages({ threadId: 'thread-1', limit: 1.5 }),
    );
    expect(badLimit.message).toContain('limit');
  });

  it('listMessages 对未知 thread 返回空列表(与"无消息"不可区分,同真实后端)', async () => {
    const store = createInMemoryStore();
    await expect(store.listMessages({ threadId: 'nope' })).resolves.toEqual([]);
  });
});

describe('deleteThread 级联', () => {
  it('删 thread 级联删其消息;别的 thread 与 resource 级数据不动;未知 id 静默通过', async () => {
    const store = createInMemoryStore();
    await store.saveThread(makeThread({ id: 'thread-1', resourceId: 'user-1' }));
    await store.saveThread(makeThread({ id: 'thread-2', resourceId: 'user-1' }));
    await store.saveMessages([
      makeMessage({ id: 'm1', threadId: 'thread-1' }),
      makeMessage({ id: 'm2', threadId: 'thread-1' }),
      makeMessage({ id: 'm9', threadId: 'thread-2' }),
    ]);
    await store.saveResource({
      id: 'user-1',
      workingMemory: { goal: 'ship M2' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await store.deleteThread('thread-1');

    await expect(store.getThreadById('thread-1')).resolves.toBeNull();
    await expect(store.listMessages({ threadId: 'thread-1' })).resolves.toEqual([]);
    // 别的 thread 与其消息不动
    await expect(store.getThreadById('thread-2')).resolves.not.toBeNull();
    await expect(store.listMessages({ threadId: 'thread-2' })).resolves.toHaveLength(1);
    // resource 级数据(工作记忆的归属)不动
    const resource = await store.getResource('user-1');
    expect(resource?.workingMemory).toEqual({ goal: 'ship M2' });

    // 未知 id 不报错
    await store.deleteThread('nope');
  });
});

describe('resource 读写(条件 2)', () => {
  it('saveResource upsert + getResource;未知 id 返回 null', async () => {
    const store = createInMemoryStore();
    await expect(store.getResource('nope')).resolves.toBeNull();

    const created = {
      id: 'user-1',
      workingMemory: { preferences: { language: 'zh' } },
      createdAt: new Date(1_700_000_000_000),
      updatedAt: new Date(1_700_000_000_000),
    };
    await store.saveResource(created);
    await expect(store.getResource('user-1')).resolves.toEqual(created);

    const updated = {
      ...created,
      workingMemory: { preferences: { language: 'en' } },
      updatedAt: new Date(1_700_000_060_000),
    };
    await store.saveResource(updated);
    const got = await store.getResource('user-1');
    expect(got?.workingMemory).toEqual({ preferences: { language: 'en' } });
    expect(got?.createdAt).toEqual(created.createdAt);
  });
});

describe('快照隔离', () => {
  it('读出来的是深拷贝:改返回值不动库存;存进去的也是深拷贝:事后改入参不动库存', async () => {
    const store = createInMemoryStore();
    const thread = makeThread({ id: 'thread-1', metadata: { tags: ['a'] } });
    await store.saveThread(thread);
    // 事后改入参,库存不受影响
    thread.title = 'mutated-after-save';
    (thread.metadata as { tags: string[] }).tags.push('b');

    const got = await store.getThreadById('thread-1');
    expect(got?.title).not.toBe('mutated-after-save');
    expect(got?.metadata).toEqual({ tags: ['a'] });

    // 改读回值,库存不受影响
    got!.title = 'mutated-after-read';
    (got!.metadata as { tags: string[] }).tags.push('c');
    const again = await store.getThreadById('thread-1');
    expect(again?.title).not.toBe('mutated-after-read');
    expect(again?.metadata).toEqual({ tags: ['a'] });
  });

  it('消息同样隔离:改 listMessages 读回值的内容部分不动库存', async () => {
    const store = createInMemoryStore();
    await store.saveMessages([
      makeMessage({ id: 'm1', content: [{ type: 'text', text: 'original' }] }),
    ]);

    const listed = await store.listMessages({ threadId: 'thread-1' });
    const first = listed[0];
    if (first?.role !== 'user') throw new Error('expected a user message');
    const part = first.content[0];
    if (part?.type !== 'text') throw new Error('expected a text part');
    part.text = 'mutated';

    const again = await store.listMessages({ threadId: 'thread-1' });
    expect(again[0]?.content).toEqual([{ type: 'text', text: 'original' }]);
  });
});
