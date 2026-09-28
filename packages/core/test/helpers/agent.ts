import { Agent } from '@balsa/core/agent';
import type { Tool } from '@balsa/core/tools';
import type { FakeModel } from './fake-model.js';

/**
 * 测试用 agent 工厂:五字段最小表面(instructions 固定为一行),可选工具容器——多个测试文件从
 * 同一份实现取用,不各自复制(规则见 `helpers/assertions.ts`)。
 */
export function assistant(model: FakeModel): Agent {
  return new Agent({ name: 'assistant', instructions: 'You are concise.', model });
}

/** 同上的带工具版本;工具容器按测试自备。 */
export function assistantWithTools(model: FakeModel, tools: Record<string, Tool>): Agent {
  return new Agent({ name: 'assistant', instructions: 'You are concise.', model, tools });
}
