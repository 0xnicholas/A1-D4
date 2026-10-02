import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const mcpServerSource = fileURLToPath(new URL('./packages/mcp-server/src', import.meta.url));
const mcpClientSource = fileURLToPath(new URL('./packages/mcp-client/src', import.meta.url));
const sqliteSource = fileURLToPath(new URL('./packages/sqlite/src', import.meta.url));
const aiSdkSource = fileURLToPath(new URL('./packages/ai-sdk/src', import.meta.url));
const otlpSource = fileURLToPath(new URL('./packages/otlp/src', import.meta.url));
const cronerSource = fileURLToPath(new URL('./packages/croner/src', import.meta.url));

export default defineConfig({
  // 测试走 `@balsats/core/*` 与 `@balsats/mcp-server` / `@balsats/mcp-client` 公开入口,别名指向源码:不依赖构建,接缝与用户看到的一致。
  resolve: {
    alias: [
      { find: /^@balsats\/core$/, replacement: `${coreSource}/index.ts` },
      { find: /^@balsats\/core\/(.*)$/, replacement: `${coreSource}/$1/index.ts` },
      { find: /^@balsats\/mcp-server$/, replacement: `${mcpServerSource}/index.ts` },
      { find: /^@balsats\/mcp-client$/, replacement: `${mcpClientSource}/index.ts` },
      { find: /^@balsats\/sqlite$/, replacement: `${sqliteSource}/index.ts` },
      { find: /^@balsats\/ai-sdk$/, replacement: `${aiSdkSource}/index.ts` },
      { find: /^@balsats\/otlp$/, replacement: `${otlpSource}/index.ts` },
      { find: /^@balsats\/croner$/, replacement: `${cronerSource}/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
