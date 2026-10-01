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
  // 测试走 `@balsa/core/*` 与 `@balsa/mcp-server` / `@balsa/mcp-client` 公开入口,别名指向源码:不依赖构建,接缝与用户看到的一致。
  resolve: {
    alias: [
      { find: /^@balsa\/core$/, replacement: `${coreSource}/index.ts` },
      { find: /^@balsa\/core\/(.*)$/, replacement: `${coreSource}/$1/index.ts` },
      { find: /^@balsa\/mcp-server$/, replacement: `${mcpServerSource}/index.ts` },
      { find: /^@balsa\/mcp-client$/, replacement: `${mcpClientSource}/index.ts` },
      { find: /^@balsa\/sqlite$/, replacement: `${sqliteSource}/index.ts` },
      { find: /^@balsa\/ai-sdk$/, replacement: `${aiSdkSource}/index.ts` },
      { find: /^@balsa\/otlp$/, replacement: `${otlpSource}/index.ts` },
      { find: /^@balsa\/croner$/, replacement: `${cronerSource}/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
