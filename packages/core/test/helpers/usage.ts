/**
 * 测试共享的 usage 常量:模型未报告 token 数时 run 的 usage 三项均未定义(unknown 不塌成 0,
 * `docs/architecture/agent.md`「steps[]」)。多个测试文件从同一份实现取用,不各自复制(规则见
 * `helpers/assertions.ts`)。
 */
export const UNKNOWN_USAGE = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};
