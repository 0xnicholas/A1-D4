import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool } from '@balsa/core/tools';
import type { Tool, ToolConfig } from '@balsa/core/tools';
import { expectAssignable } from './helpers/assertions.js';

/**
 * 工具定义表面(M1-06 #27,ADR-0008 / tools.md):`createTool` 四字段工厂——返回冻结普通对象,
 * execute 的 input/output 类型从 Standard Schema 双接口推出;手写字面量同等合法;无参工具省略
 * inputSchema,input 类型为 undefined。容器形状与模型侧 JSON Schema 断言见 `agent-tools.test.ts`,
 * 契约对校见 `standard-schema-contract.test.ts`。
 */
describe('createTool:冻结普通对象', () => {
  it('返回冻结的普通对象,四字段原样(引用不复制)', () => {
    const inputSchema = z.object({ city: z.string() });
    const outputSchema = z.object({ celsius: z.number() });
    const execute = (input: { city: string }) => ({ celsius: input.city.length });

    const tool = createTool({
      description: 'Looks up the weather.',
      inputSchema,
      outputSchema,
      execute,
    });

    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.getPrototypeOf(tool)).toBe(Object.prototype);
    expect(Object.keys(tool).sort()).toEqual([
      'description',
      'execute',
      'inputSchema',
      'outputSchema',
    ]);
    expect(tool.description).toBe('Looks up the weather.');
    expect(tool.inputSchema).toBe(inputSchema);
    expect(tool.outputSchema).toBe(outputSchema);
    expect(tool.execute).toBe(execute);
  });

  it('无参工具省略 inputSchema / outputSchema:返回对象不含这两个键', () => {
    const tool = createTool({
      description: 'Pings the service.',
      execute: () => 'pong',
    });

    expect(Object.keys(tool).sort()).toEqual(['description', 'execute']);
    expect(tool.inputSchema).toBeUndefined();
    expect(tool.outputSchema).toBeUndefined();
  });

  it('冻结:字段不可改写(严格模式下改写抛 TypeError)', () => {
    const tool = createTool({ description: 'Pings.', execute: () => 'pong' });

    expect(() => {
      (tool as { description: string }).description = 'changed';
    }).toThrow(TypeError);
    expect(tool.description).toBe('Pings.');
  });
});

describe('createTool:类型从 schema 推出', () => {
  it('execute 的 input 由 inputSchema 推出、output 由 outputSchema 推出', () => {
    const tool = createTool({
      description: 'Converts Celsius to Fahrenheit.',
      inputSchema: z.object({ celsius: z.number() }),
      outputSchema: z.object({ fahrenheit: z.number() }),
      execute: (input) => {
        const celsius: number = input.celsius;
        return { fahrenheit: celsius * 1.8 + 32 };
      },
    });

    expectAssignable<Tool<{ celsius: number }, { fahrenheit: number }>>(tool);
  });

  it('无 outputSchema 的工具:execute 可返回任意值', () => {
    const tool = createTool({
      description: 'Counts characters.',
      inputSchema: z.object({ text: z.string() }),
      execute: (input) => input.text.length,
    });

    expectAssignable<Tool<{ text: string }, unknown>>(tool);
  });

  it('无参工具的 input 类型为 undefined', () => {
    const tool = createTool({
      description: 'Pings.',
      execute: (input) => {
        const nothing: undefined = input;
        return nothing;
      },
    });

    expectAssignable<Tool<undefined, unknown>>(tool);
  });

  it('input 取 schema 之外的字段是编译错误', () => {
    createTool({
      description: 'Converts Celsius.',
      inputSchema: z.object({ celsius: z.number() }),
      execute: (input) => {
        // @ts-expect-error schema 未声明 fahrenheit
        return input.fahrenheit;
      },
    });
  });

  it('outputSchema 存在时,返回值不合 schema 是编译错误', () => {
    createTool({
      description: 'Converts Celsius.',
      inputSchema: z.object({ celsius: z.number() }),
      outputSchema: z.object({ fahrenheit: z.number() }),
      // @ts-expect-error 返回值缺 fahrenheit
      execute: () => ({ celsius: 1 }),
    });
  });

  it('description 必填', () => {
    // @ts-expect-error 缺 description
    createTool({ execute: () => 'pong' });
  });

  it('execute 必填', () => {
    // @ts-expect-error 缺 execute
    createTool({ description: 'Pings.' });
  });

  it('裸 ToolConfig 注解接受任意双接口 schema(schema 类型参数取宽默认)', () => {
    expectAssignable<ToolConfig>({
      description: 'Looks up the weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: () => 'ok',
    });
  });
});

describe('工具容器:手写字面量与混装', () => {
  it('手写字面量工具(不经过工厂)通过类型检查,可直接进容器', () => {
    const tool: Tool = {
      description: 'Searches the web.',
      inputSchema: z.object({ query: z.string() }),
      execute: (input: { query: string }) => input.query.length,
    };

    expectAssignable<Record<string, Tool>>({ search: tool });
  });

  it('createTool 产物与字面量混装在同一容器', () => {
    const fromFactory = createTool({
      description: 'Pings.',
      execute: () => 'pong',
    });
    const handwritten: Tool<{ city: string }, string> = {
      description: 'Looks up the weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: (input) => input.city,
    };

    expectAssignable<Record<string, Tool>>({ ping: fromFactory, weather: handwritten });
  });
});
