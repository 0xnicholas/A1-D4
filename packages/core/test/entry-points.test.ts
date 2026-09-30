import { describe, expect, it } from 'vitest';
import * as rootEntry from '@balsa/core';
import * as agentEntry from '@balsa/core/agent';
import * as durableAgentEntry from '@balsa/core/durable-agent';
import * as memoryEntry from '@balsa/core/memory';
import * as modelEntry from '@balsa/core/model';
import * as observabilityEntry from '@balsa/core/observability';
import * as schedulesEntry from '@balsa/core/schedules';
import * as signalsEntry from '@balsa/core/signals';
import * as toolsEntry from '@balsa/core/tools';
import * as workflowsEntry from '@balsa/core/workflows';

/**
 * 每个公开子路径入口都能经工具链加载。vitest 把 `@balsa/core/*` 别名到源码(不依赖构建);
 * 构建产物层的同一个面由 `pnpm check:dist` 用真实包自引用验真。
 */
const ENTRIES = [
  ['@balsa/core', rootEntry],
  ['@balsa/core/model', modelEntry],
  ['@balsa/core/agent', agentEntry],
  ['@balsa/core/tools', toolsEntry],
  ['@balsa/core/observability', observabilityEntry],
  ['@balsa/core/workflows', workflowsEntry],
  ['@balsa/core/memory', memoryEntry],
  ['@balsa/core/signals', signalsEntry],
  ['@balsa/core/durable-agent', durableAgentEntry],
  ['@balsa/core/schedules', schedulesEntry],
] as const;

describe('子路径入口可加载', () => {
  it.each(ENTRIES)('%s 可加载', (_specifier, entry) => {
    expect(entry).toBeTypeOf('object');
  });
});
