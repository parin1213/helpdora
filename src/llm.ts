import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions.js";
import type { z } from "zod";
import type { Config } from "./config.js";
import { flattenMessages, runProvider } from "./providers/cli-subprocess.js";
import { ThinkingSpinner } from "./render.js";

export type DebugHook = {
  onStart?: (info: { messages: ChatCompletionMessageParam[]; model: string; tools?: number }) => void;
  onTokenStats?: (stats: { completionTokens?: number; totalTokens?: number; elapsedMs: number }) => void;
  onToolCall?: (info: { name: string; args: string; resultChars: number }) => void;
};

export type StreamEvent =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string };

export type StreamChatOptions = {
  debug?: DebugHook;
};

export type StructuredOptions<T extends z.ZodTypeAny> = {
  schema: T;
  schemaName: string;
  tools?: ChatCompletionTool[];
  handleTool?: (call: ChatCompletionMessageFunctionToolCall) => Promise<string>;
  maxToolCalls?: number;
  debug?: DebugHook;
};

export class Dora {
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

    // Premium providers don't stream — run the subprocess to completion and
    // emit the whole response in one content chunk. A spinner is shown
    // meanwhile so the user has visible feedback.
    //
    // Subprocess providers need a much longer deadline than the default
    // `timeoutMs` (120s), which is sized for fast local API calls. A
    // FULL-mode translation of a 77KB man page through `claude -p` can
    // easily run 3-5 minutes; kill early = lost output. Bound to at least
    // 15 min.
    if (this.cfg.provider === "claude" || this.cfg.provider === "codex") {
      const subprocessTimeout = Math.max(this.cfg.timeoutMs, 15 * 60 * 1000);
      const spinner = new ThinkingSpinner();
      spinner.start(`${this.cfg.provider} 思考中`);
      try {
        const prompt = flattenMessages(messages);
        const text = await runProvider(this.cfg.provider, prompt, subprocessTimeout);
        opts.debug?.onTokenStats?.({ elapsedMs: Date.now() - t0 });
        yield { kind: "content", text };
      } finally {
        spinner.stop();
      }
      return;
    }

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
    if (this.cfg.provider === "claude" || this.cfg.provider === "codex") {
      throw new Error(
        `provider="${this.cfg.provider}" は INTENT/LOOKUP 非対応です (v1)。` +
          `--provider lm-studio で再実行してください`,
      );
    }
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
          // helpdora は function tool しか登録していないので custom tool は無視。
          if (call.type !== "function") continue;
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

    // Final structured call. Qwen3.5 occasionally returns empty content
    // from LM Studio's parse helper — retry once with a fresh request before
    // giving up. Empirically fixes most transient INTENT failures.
    const MAX_RETRIES = 2;
    let parsed: z.infer<T> | null = null;
    let lastRes: Awaited<ReturnType<typeof this.client.chat.completions.parse>> | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      opts.debug?.onStart?.({ messages: working, model: this.cfg.model });
      const res = await this.client.chat.completions.parse({
        model: this.cfg.model,
        messages: working,
        response_format: zodResponseFormat(opts.schema, opts.schemaName),
      });
      lastRes = res;
      const got = res.choices[0]?.message.parsed;
      if (got != null) {
        parsed = got;
        break;
      }
      opts.debug?.onTokenStats?.({
        completionTokens: res.usage?.completion_tokens,
        totalTokens: res.usage?.total_tokens,
        elapsedMs: Date.now() - t0,
      });
    }
    if (parsed == null) {
      throw new Error("LLM returned no parsed structured output (after retries)");
    }

    opts.debug?.onTokenStats?.({
      completionTokens: lastRes?.usage?.completion_tokens,
      totalTokens: lastRes?.usage?.total_tokens,
      elapsedMs: Date.now() - t0,
    });

    return { parsed, messages: working };
  }
}
