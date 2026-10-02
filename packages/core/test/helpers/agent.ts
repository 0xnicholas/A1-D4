import { Agent } from '@balsats/core/agent';
import type { ModelInput } from '@balsats/core/agent';
import type { Tool } from '@balsats/core/tools';

/** 测试 fixture:一行 system 指令。多个测试文件从同一份实现取用,不各自复制。 */
export const INSTRUCTIONS = 'You are concise.';

/**
 * 测试用 agent 工厂:五字段最小表面(instructions 固定为一行),可选工具容器——多个测试文件从
 * 同一份实现取用,不各自复制(规则见 `helpers/assertions.ts`)。model 接受 `ModelInput` 全形状,
 * 单实例与 fallback 链共用同一份构造。
 */
export function assistant(model: ModelInput): Agent {
  return new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });
}

/** 同上的带工具版本;工具容器按测试自备。 */
export function assistantWithTools(model: ModelInput, tools: Record<string, Tool>): Agent {
  return new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, tools });
}
