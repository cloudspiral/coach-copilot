import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";
import type { AppConfig } from "./config.js";
import type { ModelCallTrace } from "../shared/schemas.js";

export interface StructuredResult<T> {
  value: T;
  trace: ModelCallTrace;
}

export interface StructuredModelGateway {
  readonly available: boolean;
  readonly model: string;
  runStructured<T>(options: {
    stage: string;
    schemaName: string;
    schema: ZodType<T>;
    system: string;
    user: string;
  }): Promise<StructuredResult<T>>;
}

export class OpenAIStructuredGateway implements StructuredModelGateway {
  readonly available: boolean;
  readonly model: string;
  private readonly client?: OpenAI;
  private readonly effort: AppConfig["reasoningEffort"];

  constructor(config: AppConfig) {
    this.available = Boolean(config.apiKey);
    this.model = config.model;
    this.effort = config.reasoningEffort;
    if (config.apiKey) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        maxRetries: 0,
        timeout: 45_000,
      });
    }
  }

  async runStructured<T>(options: {
    stage: string;
    schemaName: string;
    schema: ZodType<T>;
    system: string;
    user: string;
  }): Promise<StructuredResult<T>> {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured");
    const startedAt = performance.now();
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        { role: "system", content: options.system },
        { role: "user", content: options.user },
      ],
      text: {
        format: zodTextFormat(options.schema, options.schemaName),
        verbosity: "low",
      },
      reasoning: { effort: this.effort },
      store: false,
    });
    const parsed = response.output_parsed;
    if (!parsed) {
      const refusal = response.output
        .flatMap((item) => item.type === "message" ? item.content : [])
        .find((item) => item.type === "refusal");
      throw new Error(refusal && "refusal" in refusal ? `Model refusal: ${refusal.refusal}` : "Model returned no structured output");
    }
    return {
      value: parsed,
      trace: {
        stage: options.stage,
        responseId: response.id,
        latencyMs: Math.round(performance.now() - startedAt),
        tokenUsage: response.usage ? { ...response.usage } : {},
      },
    };
  }
}

export class ControlledStructuredGateway implements StructuredModelGateway {
  readonly available = true;
  readonly model: string;
  private counter = 0;

  constructor(
    model = "controlled-test-model",
    private readonly handler?: (stage: string, user: string) => unknown,
  ) {
    this.model = model;
  }

  async runStructured<T>(options: {
    stage: string;
    schemaName: string;
    schema: ZodType<T>;
    system: string;
    user: string;
  }): Promise<StructuredResult<T>> {
    this.counter += 1;
    const raw = this.handler?.(options.stage, options.user);
    if (raw === undefined) throw new Error(`No controlled response configured for ${options.stage}`);
    return {
      value: options.schema.parse(raw),
      trace: {
        stage: options.stage,
        responseId: `controlled-${this.counter}`,
        latencyMs: 1,
        tokenUsage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    };
  }
}
