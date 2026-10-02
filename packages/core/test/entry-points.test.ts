import { describe, expect, it } from 'vitest';
import * as rootEntry from '@balsats/core';
import * as agentEntry from '@balsats/core/agent';
import * as durableAgentEntry from '@balsats/core/durable-agent';
import * as memoryEntry from '@balsats/core/memory';
import * as modelEntry from '@balsats/core/model';
import * as observabilityEntry from '@balsats/core/observability';
import * as schedulesEntry from '@balsats/core/schedules';
import * as signalsEntry from '@balsats/core/signals';
import * as toolsEntry from '@balsats/core/tools';
import * as workflowsEntry from '@balsats/core/workflows';

/**
 * 每个公开子路径入口都能经工具链加载。vitest 把 `@balsats/core/*` 别名到源码(不依赖构建);
 * 构建产物层的同一个面由 `pnpm check:dist` 用真实包自引用验真。
 */
const ENTRIES = [
  ['@balsats/core', rootEntry],
  ['@balsats/core/model', modelEntry],
  ['@balsats/core/agent', agentEntry],
  ['@balsats/core/tools', toolsEntry],
  ['@balsats/core/observability', observabilityEntry],
  ['@balsats/core/workflows', workflowsEntry],
  ['@balsats/core/memory', memoryEntry],
  ['@balsats/core/signals', signalsEntry],
  ['@balsats/core/durable-agent', durableAgentEntry],
  ['@balsats/core/schedules', schedulesEntry],
] as const;

describe('子路径入口可加载', () => {
  it.each(ENTRIES)('%s 可加载', (_specifier, entry) => {
    expect(entry).toBeTypeOf('object');
  });
});
