import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('./packages/core/src', import.meta.url));

export default defineConfig({
  // 测试走 `@balsa/core/*` 公开子路径,别名指向源码:不依赖构建,接缝与用户看到的一致。
  resolve: {
    alias: [
      { find: /^@balsa\/core$/, replacement: `${coreSource}/index.ts` },
      { find: /^@balsa\/core\/(.*)$/, replacement: `${coreSource}/$1/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
