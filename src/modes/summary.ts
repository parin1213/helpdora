import type { Dora } from "../llm.js";
import type { Config } from "../config.js";
import type { HelpResult } from "../help-fetcher.js";
import { fetchHelp } from "../help-fetcher.js";
import { streamRaw, isSupportedModel } from "../llm-raw.js";
import { writeChunk, writeDebug, writeDim, writeLine, writeReasoningChunk, writeReasoningEnd } from "../render.js";
import { MarkdownStream } from "../stream-md.js";
import { cacheKey, cacheRead, cacheWrite, type CacheOptions } from "../cache.js";
import { DORAEMON_CORE, DORAEMON_CODE_EXEMPT } from "../tone/doraemon.js";

const SYSTEM_PROMPT = `あなたは Unix/Linux/macOS コマンドに精通した実務家です。
与えられた英語のヘルプテキストを元に、**コマンドの要点とよく使うレシピ** を日本語で簡潔にまとめます。
全オプションを列挙する逐語訳はしないこと（それは --full モードの役目です）。

出力構成（この順で、この構造のまま）:

1. \`# <cmd> — 一言説明\` の見出し（1 行、役割が瞬時に分かる表現）
2. 空行
3. \`## よく使うレシピ\` 見出し
4. 3〜5 個の実用レシピ。フォーマット:
   \`\`\`
   - \`実行可能な1行コマンド\` — 日本語の短い説明
   \`\`\`
   - コマンドは**コピペで実行できる完全な1行**にする（プレースホルダ名は \`<file>\` / \`<dir>\` 等の日本で一般的な記法）
   - 頻度順（最も使う → 応用）、重複や些末な差分だけの項目は入れない
5. 注意点があれば最後に \`## 注意\` 見出しで 1〜3 個。BSD/GNU の差、破壊的操作など

※ "詳細は …" の案内は CLI 側で自動追記するので、LLM が出力する必要はありません。

ルール:
- オプション名（\`-x\`, \`--xxx\`）、コマンド名、パスは**原文のまま**
- 推測で原文にない機能を書かない
- "例:" "説明:" などの冗長なラベルは付けない
- 絵文字は使わない`;

const DORA_TONE_APPEND = `\n\n${DORAEMON_CORE}\n${DORAEMON_CODE_EXEMPT}`;

function systemPromptFor(tone: "default" | "dora" | undefined): string {
  return tone === "dora" ? SYSTEM_PROMPT + DORA_TONE_APPEND : SYSTEM_PROMPT;
}

export interface SummaryOptions {
  man?: boolean;
  raw?: boolean;
  stream?: boolean;
  debug?: boolean;
  bypassThinking?: boolean;
  tone?: "default" | "dora";
  cache?: CacheOptions;
  /** Suppress all stdout rendering; still populates cache. Used by precache. */
  quiet?: boolean;
  /** Called after the final write so callers can tell cache-hit from miss. */
  onComplete?: (info: { cacheHit: boolean; bytes: number }) => void;
}

// SUMMARY は要点抽出だけなので、巨大ヘルプ (rg 74KB, git diff man 40KB など)
// を投入するとコンテキストを食いつぶして 0 トークン返答になる。更に --dora
// の tone prompt も乗る分を見込んで控えめに。超えたら retry で半分に絞る。
const SUMMARY_MAX_HELP_BYTES = 28 * 1024;
const SUMMARY_RETRY_MAX_HELP_BYTES = 14 * 1024;

export async function summary(
  dora: Dora,
  cfg: Config,
  cmd: string,
  args: readonly string[],
  opts: SummaryOptions,
): Promise<void> {
  const t0 = Date.now();
  let help = await fetchHelp(cmd, args, {
    source: opts.man ? "man" : "auto",
    maxBytes: SUMMARY_MAX_HELP_BYTES,
  });
  const fetchedIn = Date.now() - t0;

  if (opts.debug) {
    writeDebug(`help source=${help.source} bytes=${Buffer.byteLength(help.text, "utf8")} fetched_in=${fetchedIn}ms`);
  }

  const tone = opts.tone ?? "default";
  // Thinking bypass is an LM-Studio-specific trick (injects <think></think>
  // into the assistant turn on /v1/completions). Don't attempt it on
  // claude/codex subprocess providers.
  const useBypass =
    (opts.bypassThinking ?? true) && cfg.provider === "lm-studio" && isSupportedModel(cfg.model);

  // NOTE: help.text is intentionally excluded from the cache key. If it
  // were included, the 28KB-first / 14KB-retry flow below would write to
  // a different key than the key we probe on the next call, forcing a
  // rerun of the LLM every time for big-help commands (rg, git diff).
  // help.source stays in the key so `--help` vs `man` vs `-h` invalidate.
  // Use `--refresh` to force regeneration if the help text genuinely
  // changes (e.g., after upgrading the underlying binary).
  const cacheK = cacheKey(
    ["summary", cfg.provider, cfg.model, cfg.baseUrl, tone, useBypass, help.source],
    `summary--${cfg.provider}--${[cmd, ...args].join("_")}`,
  );
  const cacheOpts = opts.cache ?? {};

  const hit = cacheRead(cacheK, cacheOpts);
  if (!opts.quiet) {
    const header = `# ${[cmd, ...args].join(" ")} — 要点 (source: ${help.source}${hit ? ", cached" : ""})`;
    writeDim(header);
    writeLine();
  }

  if (hit) {
    if (opts.debug) writeDebug(`cache hit: bytes=${hit.length}`);
    if (!opts.quiet) {
      const md = new MarkdownStream();
      md.write(hit);
      md.end();
      if (opts.raw) appendRaw(help.text);
    }
    opts.onComplete?.({ cacheHit: true, bytes: hit.length });
    return;
  }


  if (opts.debug) {
    writeDebug(`thinking bypass: ${useBypass ? "on" : "off"} | tone=${tone}`);
  }

  // First attempt
  let accumulator = await runLlm(dora, cfg, help, tone, useBypass, opts);

  // If the model returned nothing, the most common reason is that the
  // prompt (system + ~28KB help + tone) exceeded the model's context.
  // Truncate the help more aggressively and retry once before giving up.
  if (accumulator.trim().length === 0 && help.text.length > SUMMARY_RETRY_MAX_HELP_BYTES) {
    if (opts.debug) writeDebug(`empty response; retrying with smaller help (${SUMMARY_RETRY_MAX_HELP_BYTES}B max)`);
    help = await fetchHelp(cmd, args, {
      source: opts.man ? "man" : "auto",
      maxBytes: SUMMARY_RETRY_MAX_HELP_BYTES,
    });
    accumulator = await runLlm(dora, cfg, help, tone, useBypass, opts);
  }

  if (accumulator.trim().length === 0) {
    throw new EmptyResponseError(cmd, args, help.text.length);
  }

  if (accumulator.trim().length > 30) {
    cacheWrite(cacheK, accumulator, cacheOpts);
    if (opts.debug) writeDebug(`cached: bytes=${accumulator.length}`);
  }

  if (opts.raw && !opts.quiet) appendRaw(help.text);
  opts.onComplete?.({ cacheHit: false, bytes: accumulator.length });
}

/** One end-to-end LLM call for SUMMARY. Returns the accumulated content,
 *  or "" if the model produced nothing. Handles both the bypass-thinking
 *  `/v1/completions` path and the standard streaming chat. */
async function runLlm(
  dora: Dora,
  cfg: Config,
  help: HelpResult,
  tone: "default" | "dora",
  useBypass: boolean,
  opts: SummaryOptions,
): Promise<string> {
  const systemPrompt = systemPromptFor(tone);
  const user = userPrompt(help);
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: user },
  ];

  const md = opts.quiet ? null : new MarkdownStream();
  let accumulator = "";
  const emitChunk = (s: string): void => {
    accumulator += s;
    if (opts.quiet || opts.stream === false) return;
    md?.write(s);
  };
  const finishContent = (): void => {
    if (opts.quiet) return;
    if (opts.stream === false) md?.write(accumulator);
    md?.end();
  };

  if (useBypass) {
    let tokens = 0;
    const tBypass = Date.now();
    for await (const chunk of streamRaw(cfg, messages, {
      suppressThinking: true,
      debug: opts.debug
        ? {
            onStart: (i) => writeDebug(`raw start model=${i.model} prompt=${i.promptChars}ch`),
            onTokenStats: (s) => writeDebug(`raw done tokens=${s.completionTokens} in=${s.elapsedMs}ms`),
          }
        : undefined,
    })) {
      tokens++;
      emitChunk(chunk);
    }
    finishContent();
    if (opts.debug) writeDebug(`total tokens=${tokens} elapsed=${Date.now() - tBypass}ms`);
  } else {
    let contentStarted = false;
    let reasoningStarted = false;
    for await (const ev of dora.streamChat(messages, debugHook(opts.debug))) {
      if (ev.kind === "reasoning") {
        if (!reasoningStarted) {
          process.stderr.write("\n");
          reasoningStarted = true;
        }
        writeReasoningChunk(ev.text);
        continue;
      }
      if (!contentStarted) {
        if (reasoningStarted) writeReasoningEnd();
        contentStarted = true;
      }
      emitChunk(ev.text);
    }
    finishContent();
  }

  return accumulator;
}

export class EmptyResponseError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: readonly string[],
    public readonly promptBytes: number,
  ) {
    super(
      `LLM が空応答を返しました (${[cmd, ...args].join(" ")}, help=${promptBytes}B)。` +
        `プロンプトがモデルのコンテキストを超えた可能性があります。` +
        `LM Studio でコンテキスト長を上げるか、--full を避けて再実行してください。`,
    );
    this.name = "EmptyResponseError";
  }
}

function appendRaw(text: string): void {
  writeLine();
  writeDim("--- 原文 ---");
  writeLine(text);
}

function userPrompt(help: HelpResult): string {
  const label = help.source === "man" ? "man" : `${help.cmd} ${help.args.join(" ")} --help`.trim();
  return `コマンド: ${[help.cmd, ...help.args].join(" ")}
取得元: ${label}

--- ヘルプ本文 ---
${help.text}`;
}

function debugHook(debug: boolean | undefined) {
  if (!debug) return {};
  return {
    debug: {
      onStart: (i: { messages: unknown[]; model: string }) =>
        writeDebug(`chat start model=${i.model} messages=${i.messages.length}`),
      onTokenStats: (s: { completionTokens?: number; totalTokens?: number; elapsedMs: number }) =>
        writeDebug(`chat done tokens=${s.completionTokens ?? "?"}/${s.totalTokens ?? "?"} in=${s.elapsedMs}ms`),
    },
  };
}

export function writeSummaryFooter(cmd: string, args: readonly string[]): void {
  writeLine();
  const full = ["dora", "--full", cmd, ...args].join(" ");
  writeDim(`詳細は \`${full}\``);
}
