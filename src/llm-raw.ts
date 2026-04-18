import type { Config } from "./config.js";

export interface RawMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RawDebugHook {
  onStart?: (info: { promptChars: number; model: string }) => void;
  onTokenStats?: (stats: { completionTokens: number; elapsedMs: number }) => void;
}

export interface StreamRawOptions {
  suppressThinking?: boolean;
  debug?: RawDebugHook;
}

/**
 * Bypass LM Studio's chat template application by formatting the Qwen3-style
 * prompt ourselves and calling /v1/completions directly. This lets us inject
 * `<think>\n\n</think>\n\n` at the start of the assistant turn, which
 * suppresses the reasoning pass (LM Studio ignores `chat_template_kwargs`).
 *
 * Only safe for Qwen3 / Qwen3.5 chat tokens; see isSupportedModel().
 */
export async function* streamRaw(
  cfg: Config,
  messages: RawMessage[],
  opts: StreamRawOptions = {},
): AsyncGenerator<string> {
  const suppress = opts.suppressThinking ?? true;
  const prompt = formatQwenPrompt(messages, suppress);
  opts.debug?.onStart?.({ promptChars: prompt.length, model: cfg.model });

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let completionTokens = 0;
  try {
    const res = await fetch(`${cfg.baseUrl}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        prompt,
        stream: true,
        stop: ["<|im_end|>", "<|endoftext|>"],
        max_tokens: 8000,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : "";
      throw new Error(`completions request failed: ${res.status} ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: { choices?: { text?: string }[] };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        const text = chunk.choices?.[0]?.text;
        if (text) {
          completionTokens++;
          yield text;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    opts.debug?.onTokenStats?.({ completionTokens, elapsedMs: Date.now() - t0 });
  }
}

function formatQwenPrompt(messages: readonly RawMessage[], suppressThinking: boolean): string {
  const turns = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`);
  turns.push("<|im_start|>assistant");
  let out = turns.join("\n") + "\n";
  if (suppressThinking) out += "<think>\n\n</think>\n\n";
  return out;
}

/**
 * Heuristic: identify models that use Qwen's chat tokens and thus tolerate
 * our manual `<|im_start|>` formatting + `<think>` injection. Used by
 * translate mode to auto-enable the bypass only when safe.
 */
export function isSupportedModel(model: string): boolean {
  return /qwen[23]/i.test(model);
}
