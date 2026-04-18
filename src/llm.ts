import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions.js";
import type { z } from "zod";
import type { Config } from "./config.js";

export interface DebugHook {
  onStart?: (info: { messages: ChatCompletionMessageParam[]; model: string; tools?: number }) => void;
  onTokenStats?: (stats: { completionTokens?: number; totalTokens?: number; elapsedMs: number }) => void;
  onToolCall?: (info: { name: string; args: string; resultChars: number }) => void;
}

export type StreamEvent =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string };

export interface StreamChatOptions {
  debug?: DebugHook;
}

export interface StructuredOptions<T extends z.ZodTypeAny> {
  schema: T;
  schemaName: string;
  tools?: ChatCompletionTool[];
  handleTool?: (call: ChatCompletionMessageToolCall) => Promise<string>;
  maxToolCalls?: number;
  debug?: DebugHook;
}

export class Manju {
  private client: OpenAI;

  constructor(private cfg: Config) {
    this.client = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs,
    });
  }

  async *streamChat(
    messages: ChatCompletionMessageParam[],
    opts: StreamChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const t0 = Date.now();
    opts.debug?.onStart?.({ messages, model: this.cfg.model });

    const stream = await this.client.chat.completions.create({
      model: this.cfg.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
        | undefined;
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) yield { kind: "reasoning", text: reasoning };
      const content = delta?.content;
      if (content) yield { kind: "content", text: content };
      if (chunk.usage) {
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
      }
    }

    opts.debug?.onTokenStats?.({
      completionTokens,
      totalTokens,
      elapsedMs: Date.now() - t0,
    });
  }

  async structured<T extends z.ZodTypeAny>(
    messages: ChatCompletionMessageParam[],
    opts: StructuredOptions<T>,
  ): Promise<{ parsed: z.infer<T>; messages: ChatCompletionMessageParam[] }> {
    const t0 = Date.now();
    const working: ChatCompletionMessageParam[] = [...messages];
    const maxToolCalls = opts.maxToolCalls ?? 4;

    // Tool-calling loop (plain chat, no response_format)
    if (opts.tools && opts.tools.length > 0 && opts.handleTool) {
      for (let round = 0; round < maxToolCalls; round++) {
        opts.debug?.onStart?.({ messages: working, model: this.cfg.model, tools: opts.tools.length });
        const res = await this.client.chat.completions.create({
          model: this.cfg.model,
          messages: working,
          tools: opts.tools,
          tool_choice: "auto",
        });
        const msg = res.choices[0]?.message;
        if (!msg) break;

        const toolCalls = msg.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          working.push({ role: "assistant", content: msg.content ?? "" });
          break;
        }

        working.push({
          role: "assistant",
          content: msg.content ?? "",
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const result = await opts.handleTool(call);
          opts.debug?.onToolCall?.({
            name: call.function.name,
            args: call.function.arguments,
            resultChars: result.length,
          });
          working.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
      }
    }

    // Final structured call
    opts.debug?.onStart?.({ messages: working, model: this.cfg.model });
    const res = await this.client.beta.chat.completions.parse({
      model: this.cfg.model,
      messages: working,
      response_format: zodResponseFormat(opts.schema, opts.schemaName),
    });
    const parsed = res.choices[0]?.message.parsed;
    if (parsed == null) {
      throw new Error("LLM returned no parsed structured output");
    }

    opts.debug?.onTokenStats?.({
      completionTokens: res.usage?.completion_tokens,
      totalTokens: res.usage?.total_tokens,
      elapsedMs: Date.now() - t0,
    });

    return { parsed, messages: working };
  }
}
