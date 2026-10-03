import { describe, expect, it } from 'vitest';
import { captureRejection } from './assertions.js';
import { collect } from './collect.js';

/**
 * 输出对象行为契约(#127):懒启动单遍泵的行为矩阵钉在这一个参数化辅助上,agent 与 workflows
 * 套件各自以公开面构造的输出对象喂它(测试纪律:零内部 import)。两域仅源形状不同——agent
 * 拉 generator、workflow 推 promise+emit——共享泵必须让同一矩阵在两侧全绿:
 * 懒启动 / 缓冲排空序 / 错误在缓冲后 / abandon 后终值仍 settle / 提前 settle / 单迭代器同一性。
 */

/** 一只被测输出对象、它的期望值与探针(每次调用脚本工厂造一只新对象,各用例互不消费)。 */
export interface OutputObjectScript<TChunk> {
  /** 被测输出对象。 */
  readonly output: AsyncIterable<TChunk>;
  /** 读它的一只终值——调用即读取惰性 getter(会启动 run),故以 thunk 延后。 */
  readonly readTerminal: () => Promise<unknown>;
  /** 源启动探针:模型已调用 / step 已执行。 */
  readonly started: () => boolean;
  /** 期望按序收到的 chunk(可含 `expect.any` 等非对称 matcher)。 */
  readonly chunks: readonly unknown[];
  /** 期望的终值(可含非对称 matcher)。 */
  readonly terminal: unknown;
}

/** 两域各自提供的脚本工厂;期望值由工厂在造 run 后计算(如 workflow 事件的 runId)。 */
export interface OutputObjectScripting<TChunk> {
  /** 造一个「按序发 chunks、以 terminal 收敛」的 run。 */
  readonly success: () => OutputObjectScript<TChunk>;
  /** 造一个「按序发 chunks 后以 error 失败」的 run;error 的身份即迭代器与终值的拒绝原因。 */
  readonly failure: () => Omit<OutputObjectScript<TChunk>, 'terminal'> & { readonly error: Error };
}

/** 把输出对象行为契约跑进当前 suite:每个用例向脚本工厂要一只新输出对象。 */
export function describeOutputObjectContract<TChunk>(scripting: OutputObjectScripting<TChunk>): void {
  describe('输出对象行为契约(共享泵)', () => {
    it('懒启动:首次消费前源不启动;迭代与读终值各自启动恰好一次 run', async () => {
      const viaIteration = scripting.success();
      expect(viaIteration.started()).toBe(false);

      expect(await collect(viaIteration.output)).toEqual(viaIteration.chunks);
      expect(viaIteration.started()).toBe(true);

      const viaTerminal = scripting.success();
      expect(viaTerminal.started()).toBe(false);

      await expect(viaTerminal.readTerminal()).resolves.toEqual(viaTerminal.terminal);
      expect(viaTerminal.started()).toBe(true);
    });

    it('缓冲排空序:先读终值再迭代,缓冲的 chunk 按流序全数交付', async () => {
      const script = scripting.success();

      await expect(script.readTerminal()).resolves.toEqual(script.terminal);

      expect(await collect(script.output)).toEqual(script.chunks);
    });

    it('错误在缓冲排空后才到达:已产 chunk 按序交付,迭代器与终值随后以同一错误 reject', async () => {
      const script = scripting.failure();
      const seen: TChunk[] = [];

      const error = await captureRejection(async () => {
        for await (const chunk of script.output) seen.push(chunk);
      });

      expect(seen).toEqual(script.chunks);
      expect(error).toBe(script.error);
      await expect(script.readTerminal()).rejects.toBe(script.error);
    });

    it('abandon 后终值仍 settle:提前 break 不取消 run,该次迭代到此为止、不再缓冲', async () => {
      const script = scripting.success();

      for await (const chunk of script.output) {
        expect(chunk).toEqual(script.chunks[0]);
        break;
      }

      await expect(script.readTerminal()).resolves.toEqual(script.terminal);
      expect(await collect(script.output)).toEqual([]);
    });

    it('提前 settle:迭代完成后才读的终值照常 resolve;重复读返回同一只 promise', async () => {
      const script = scripting.success();

      expect(await collect(script.output)).toEqual(script.chunks);

      await expect(script.readTerminal()).resolves.toEqual(script.terminal);
      expect(script.readTerminal()).toBe(script.readTerminal());
    });

    it('单迭代器同一性:Symbol.asyncIterator 的每次调用返回同一迭代器', () => {
      const script = scripting.success();

      expect(script.output[Symbol.asyncIterator]()).toBe(script.output[Symbol.asyncIterator]());
    });
  });
}
