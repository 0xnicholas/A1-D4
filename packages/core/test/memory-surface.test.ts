import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Memory, createInMemoryStore, supportsWorkingMemory } from '@balsa/core/memory';
import type {
  ListMessagesQuery,
  ListThreadsQuery,
  MemoryConfig,
  MemoryStore,
  MemoryThreadRef,
  RecallQuery,
  SaveInput,
  SaveMessage,
  StoredMessage,
  StoredResource,
  StoredThread,
  WorkingMemoryStore,
} from '@balsa/core/memory';
import type { ModelMessage } from '@balsa/core/model';
import { expectAssignable } from './helpers/assertions.js';

/**
 * MemoryStore port 类型表面(#38):StoredThread / StoredMessage / StoredResource 形状钉死
 * (docs/architecture/memory.md 存储 port 节),StoredMessage = ModelMessage + 存储信封;
 * 6 必备方法即可满足 MemoryStore,条件 2(resource 方法)成对存在即能力标志
 * (docs/architecture/storage.md 扩展面),supportsWorkingMemory 是检测约定。
 * 编译期断言为主,运行时只留最小声明性检查。
 */
describe('MemoryStore port 类型表面', () => {
  it('StoredThread / StoredResource 字段形状与 spec 一致(手写字面量的合法形状)', () => {
    const thread: StoredThread = {
      id: 'thread-1',
      resourceId: 'user-1',
      title: 'first chat',
      metadata: { source: 'test' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expectAssignable<StoredThread>(thread);
    expectAssignable<string>(thread.resourceId);

    const resource: StoredResource = {
      id: 'user-1',
      workingMemory: { preferences: { language: 'zh' } },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expectAssignable<StoredResource>(resource);

    // title / metadata / workingMemory 可缺席
    expectAssignable<StoredThread>({
      id: 't',
      resourceId: 'r',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expectAssignable<StoredResource>({ id: 'r', createdAt: new Date(), updatedAt: new Date() });
  });

  it('StoredMessage = ModelMessage + 存储信封(id / threadId / resourceId / createdAt)', () => {
    const message: StoredMessage = {
      id: 'msg-1',
      threadId: 'thread-1',
      resourceId: 'user-1',
      createdAt: new Date(),
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    };
    // 可直接喂模型:StoredMessage 结构满足 ModelMessage
    expectAssignable<ModelMessage>(message);
    expectAssignable<Date>(message.createdAt);
  });

  it('只有 6 个必备方法的 store 满足 MemoryStore;条件 2 缺席时类型上不可直接调用', () => {
    const minimal: MemoryStore = {
      getThreadById: async () => null,
      saveThread: async () => {},
      deleteThread: async () => {},
      listThreads: async () => [],
      listMessages: async () => [],
      saveMessages: async () => {},
    };
    expectAssignable<MemoryStore>(minimal);

    type GetResourcePossiblyAbsent = undefined extends MemoryStore['getResource'] ? true : false;
    type SaveResourcePossiblyAbsent = undefined extends MemoryStore['saveResource'] ? true : false;
    expectAssignable<true>(null as unknown as GetResourcePossiblyAbsent);
    expectAssignable<true>(null as unknown as SaveResourcePossiblyAbsent);

    // 查询参数形状:逐字钉在 port 签名上
    expectAssignable<ListThreadsQuery>({ resourceId: 'user-1' });
    expectAssignable<ListThreadsQuery>({ resourceId: 'user-1', limit: 20, before: 'thread-9' });
    expectAssignable<ListMessagesQuery>({ threadId: 'thread-1' });
    expectAssignable<ListMessagesQuery>({
      threadId: 'thread-1',
      limit: 10,
      before: 'msg-9',
      order: 'asc',
    });
  });

  it('能力标志检测约定:条件 2 成对存在才声明支持工作记忆,缺一只即降级', async () => {
    const minimal: MemoryStore = {
      getThreadById: async () => null,
      saveThread: async () => {},
      deleteThread: async () => {},
      listThreads: async () => [],
      listMessages: async () => [],
      saveMessages: async () => {},
    };
    expect(supportsWorkingMemory(minimal)).toBe(false);

    // 只实现一只 = 不支持(成对检测,不存在半吊子能力)
    const half: MemoryStore = { ...minimal, getResource: async () => null };
    expect(supportsWorkingMemory(half)).toBe(false);

    const full: MemoryStore = {
      ...minimal,
      getResource: async () => null,
      saveResource: async () => {},
    };
    if (!supportsWorkingMemory(full)) throw new Error('expected working memory support');
    // 窄化后条件 2 可直接调用
    expectAssignable<WorkingMemoryStore>(full);
    await expect(full.getResource('user-1')).resolves.toBeNull();
  });

  it('createInMemoryStore 从公开面导出,直接声明工作记忆能力', () => {
    const store = createInMemoryStore();
    expectAssignable<WorkingMemoryStore>(store);
    expect(supportsWorkingMemory(store)).toBe(true);
    for (const method of [
      'getThreadById',
      'saveThread',
      'deleteThread',
      'listThreads',
      'listMessages',
      'saveMessages',
      'getResource',
      'saveResource',
    ] as const) {
      expect(typeof store[method]).toBe('function');
    }
  });
});
/**
 * `Memory` 类的公开面(#39):配置表面(docs/architecture/memory.md 配置表面节)与两个实例方法
 * recall / save 的签名逐字钉死;saved messages 与 recall 返回值同形(StoredMessage),可直接喂模型;
 * workingMemory 是留位参数(语义归后续 ticket),接受但惰性。
 */
describe('Memory 类类型表面', () => {
  it('配置表面:storage / lastMessages / workingMemory 全可缺席', () => {
    expectAssignable<MemoryConfig>({});
    expectAssignable<MemoryConfig>({ lastMessages: 20 });
    expectAssignable<MemoryConfig>({ storage: createInMemoryStore() });
    expectAssignable<MemoryConfig>({
      lastMessages: 5,
      workingMemory: { schema: z.object({ tone: z.string() }) },
    });

    const memory = new Memory();
    expect(memory.lastMessages).toBe(10);
    expect(memory.workingMemory).toBeUndefined();
  });

  it('workingMemory 是留位参数:接受、保留在实例上,不改变消息历史行为', async () => {
    const schema = z.object({ tone: z.string() });
    const memory = new Memory({ workingMemory: { schema } });

    expect(memory.workingMemory?.schema).toBe(schema);

    const saved = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    await expect(memory.recall({ threadId: 'thread-1' })).resolves.toEqual(saved);
  });

  it('recall 查询形状与返回值:limit / before / order 可缺席,返回 StoredMessage 数组', async () => {
    expectAssignable<RecallQuery>({ threadId: 'thread-1' });
    expectAssignable<RecallQuery>({ threadId: 'thread-1', limit: 20 });
    expectAssignable<RecallQuery>({ threadId: 'thread-1', before: 'msg-9', order: 'desc' });

    const memory = new Memory();
    const recalled = await memory.recall({ threadId: 'thread-1' });
    expectAssignable<StoredMessage[]>(recalled);
    expectAssignable<readonly StoredMessage[]>(recalled);
  });

  it('save 入参:thread 两种形态(裸 id / 带 title+metadata);messages 的信封可给可不给', () => {
    expectAssignable<MemoryThreadRef>('thread-1');
    expectAssignable<MemoryThreadRef>({ id: 'thread-1' });
    expectAssignable<MemoryThreadRef>({
      id: 'thread-1',
      title: '会话',
      metadata: { source: 'test' },
    });

    const bare: ModelMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    // 裸 ModelMessage 可直接当 SaveMessage 用(信封由 Memory 补)
    expectAssignable<SaveMessage>(bare);
    expectAssignable<SaveMessage>({ ...bare, id: 'm-1', createdAt: new Date() });
    expectAssignable<SaveInput>({ thread: 'thread-1', resource: 'user-1', messages: [bare] });

    const batch: readonly SaveMessage[] = [bare, { ...bare, id: 'm-2' }];
    expectAssignable<SaveInput>({ thread: { id: 'thread-1' }, resource: 'user-1', messages: batch });
  });
});
