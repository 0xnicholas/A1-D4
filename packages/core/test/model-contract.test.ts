import { describe, it } from 'vitest';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type {
  Model,
  ModelCallOptions,
  ModelFinishReason,
  ModelGenerateResult,
  ModelPrompt,
  ModelStreamPart,
  ModelStreamResult,
  ModelUsage,
} from '@oribos/core/model';
import { expectAssignable } from './helpers/assertions.js';

/**
 * vendor 契约 ↔ devDependency 中真实 `@ai-sdk/provider` 的类型对校(ADR-0004 的漂移防护):
 * `pnpm typecheck` 覆盖 `test/`,上游 spec 的任何形状漂移都会让 CI 在这个文件变红。
 */
describe('vendor 模型契约 ↔ @ai-sdk/provider', () => {
  it('生态包产出的模型实例结构上天然满足 vendor 契约(零适配)', () => {
    expectAssignable<Model>(null as unknown as LanguageModelV4);
  });

  it('prompt 双向一致:核心构造的 prompt 是真实 provider 可接受的输入', () => {
    expectAssignable<LanguageModelV4Prompt>(null as unknown as ModelPrompt);
    expectAssignable<ModelPrompt>(null as unknown as LanguageModelV4Prompt);
  });

  it('call options 双向一致:模型设置透传袋与真实 spec 同构', () => {
    expectAssignable<LanguageModelV4CallOptions>(null as unknown as ModelCallOptions);
    expectAssignable<ModelCallOptions>(null as unknown as LanguageModelV4CallOptions);
  });

  it('流 part 双向一致:真实 provider 的流可被归一化层消费', () => {
    expectAssignable<ModelStreamPart>(null as unknown as LanguageModelV4StreamPart);
    expectAssignable<LanguageModelV4StreamPart>(null as unknown as ModelStreamPart);
  });

  it('结果与用量双向一致', () => {
    expectAssignable<ModelStreamResult>(null as unknown as LanguageModelV4StreamResult);
    expectAssignable<LanguageModelV4StreamResult>(null as unknown as ModelStreamResult);
    expectAssignable<ModelGenerateResult>(null as unknown as LanguageModelV4GenerateResult);
    expectAssignable<ModelUsage>(null as unknown as LanguageModelV4Usage);
    expectAssignable<ModelFinishReason>(null as unknown as LanguageModelV4FinishReason);
  });

  it('规范版本锁死:其它代的模型实例不被 vendor 契约接受', () => {
    type OtherGenerationModel = Omit<LanguageModelV4, 'specificationVersion'> & {
      specificationVersion: 'v3';
    };

    // @ts-expect-error 契约锁定 specificationVersion 'v4','v3' 代的模型实例必须被拒
    expectAssignable<Model>(null as unknown as OtherGenerationModel);
  });
});
