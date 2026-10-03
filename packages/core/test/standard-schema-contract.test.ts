import { describe, it } from 'vitest';
import type {
  StandardJSONSchemaV1 as SpecStandardJSONSchemaV1,
  StandardSchemaV1 as SpecStandardSchemaV1,
  StandardTypedV1 as SpecStandardTypedV1,
} from '@standard-schema/spec';
import { z } from 'zod';
import type {
  StandardJSONSchemaV1,
  StandardSchema,
  StandardSchemaV1,
  StandardTypedV1,
} from '@oribos/core/tools';
import { expectAssignable } from './helpers/assertions.js';

/**
 * vendor 的 Standard Schema 契约对校(M1-06 #27,ADR-0003):核心自带纯类型声明(零运行时、零类型
 * 依赖,与模型契约同一策略),CI 以 devDependency 中的真实 `@standard-schema/spec` 与 zod@4 对校,
 * 上游漂移在 tsc 阶段暴露。断言全部是编译期断言;本文件不产生运行时行为。
 */
describe('Standard Schema 契约对校', () => {
  it('基础接口与上游双向可赋值(漂移防护)', () => {
    expectAssignable<SpecStandardTypedV1<string, number>>(
      null as unknown as StandardTypedV1<string, number>,
    );
    expectAssignable<StandardTypedV1<string, number>>(
      null as unknown as SpecStandardTypedV1<string, number>,
    );

    expectAssignable<SpecStandardSchemaV1<string, number>>(
      null as unknown as StandardSchemaV1<string, number>,
    );
    expectAssignable<StandardSchemaV1<string, number>>(
      null as unknown as SpecStandardSchemaV1<string, number>,
    );

    expectAssignable<SpecStandardJSONSchemaV1<string, number>>(
      null as unknown as StandardJSONSchemaV1<string, number>,
    );
    expectAssignable<StandardJSONSchemaV1<string, number>>(
      null as unknown as SpecStandardJSONSchemaV1<string, number>,
    );
  });

  it('上游的校验结果与问题类型双向可赋值', () => {
    type SpecResult = SpecStandardSchemaV1.Result<number>;
    type Result = StandardSchemaV1.Result<number>;

    expectAssignable<SpecResult>(null as unknown as Result);
    expectAssignable<Result>(null as unknown as SpecResult);

    expectAssignable<SpecStandardSchemaV1.Issue>(null as unknown as StandardSchemaV1.Issue);
    expectAssignable<StandardSchemaV1.Issue>(null as unknown as SpecStandardSchemaV1.Issue);

    expectAssignable<SpecStandardJSONSchemaV1.Options>(
      null as unknown as StandardJSONSchemaV1.Options,
    );
    expectAssignable<StandardJSONSchemaV1.Options>(
      null as unknown as SpecStandardJSONSchemaV1.Options,
    );
  });

  it('zod@4 schema 满足契约(输入/输出推导正确)', () => {
    const schema = z.object({ city: z.string() });

    expectAssignable<StandardSchema<{ city: string }>>(schema);
    expectAssignable<StandardSchemaV1<{ city: string }, { city: string }>>(schema);
    expectAssignable<StandardJSONSchemaV1<{ city: string }, { city: string }>>(schema);
    expectAssignable<StandardTypedV1<{ city: string }, { city: string }>>(schema);
  });

  it('只有校验、没有 JSON Schema 的单接口 schema 不满足契约', () => {
    const validateOnly = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
      },
    };

    expectAssignable<StandardSchemaV1>(validateOnly);
    // @ts-expect-error 契约要求双接口:缺少 ~standard.jsonSchema
    expectAssignable<StandardSchema>(validateOnly);
  });
});
