import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { Dora } from "../llm.js";
import type { Config } from "../config.js";
import { fetchHelp, CommandNotFoundError, HelpNotFoundError } from "../help-fetcher.js";
import { PromptAnswer, type PromptAnswerT } from "../schemas.js";
import { ThinkingSpinner, writeCaveat, writeCommandBox, writeDebug, writeDim, writeLine } from "../render.js";
import { cacheKey, cacheRead, cacheWrite, type CacheOptions } from "../cache.js";
import pc from "picocolors";
import { DORAEMON_CORE, DORAEMON_CODE_EXEMPT, DORAEMON_INTENT_OPENER } from "../tone/doraemon.js";

const SYSTEM_PROMPT = `あなたはシェル/Unix コマンドのエキスパートです。
ユーザーの日本語自然言語の要望に対し、最適な実行可能コマンドを提案します。

ルール:
- **自信がない / 知らないコマンドについては、必ず get_help ツールを呼んでヘルプテキストを確認してから答える**
- \`command\` は **そのままコピー＆ペーストで実行できる完全な1行コマンド** にする
  - 必要な引数・フラグ・ファイル名プレースホルダ（例: \`archive.tgz\` / \`<file>\`）を必ず含める
  - 単にコマンド名だけ（例: \`tar\`）では NG
- プラットフォーム（macOS BSD / Linux GNU）で挙動が異なる場合は caveats に明記する
- 破壊的操作（rm, dd, mkfs, git reset --hard 等）は必ず caveats で警告する
- explanation, caveats, alternatives[].when は日本語で
- 情報源（ヘルプを実際に読んだ場合）を sources に記録する（例: "tar --help"）
- alternatives には「主コマンドの微調整版」ではなく「明確に異なるユースケース」向けの代替のみ入れる`;

const DORA_TONE_APPEND = `\n\n${DORAEMON_CORE}\n${DORAEMON_CODE_EXEMPT}`;
const DORA_TONE_INTENT = DORA_TONE_APPEND + "\n" + DORAEMON_INTENT_OPENER;

function systemPromptFor(tone: "default" | "dora" | undefined, isIntent = false): string {
  if (tone !== "dora") return SYSTEM_PROMPT;
  return SYSTEM_PROMPT + (isIntent ? DORA_TONE_INTENT : DORA_TONE_APPEND);
}

const TOOL_GET_HELP: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_help",
    description:
      "ローカルマシン上の指定コマンドの --help / man 出力を取得する。LLM が知らない・自信がないコマンドは必ずこれを呼んで事実を確認すること。",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "コマンド名（例: tar, git, rg）" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "サブコマンドや引数（例: ['commit']）。任意",
        },
        source: {
          type: "string",
          enum: ["auto", "help", "man"],
          description: "取得元。デフォルトは auto（--help → -h → man の順）",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
};

export interface PromptOptions {
  useTools?: boolean;
  maxToolCalls?: number;
  ctx?: readonly string[];
  debug?: boolean;
  tone?: "default" | "dora";
  cache?: CacheOptions;
  cfg?: Config;
  /** INTENT モード: このコマンドを使った答えを期待していることを明示する */
  targetCmd?: { cmd: string; args: readonly string[] };
}

interface ToolCallArgs {
  cmd?: unknown;
  args?: unknown;
  source?: unknown;
}

export async function promptMode(
  dora: Dora,
  question: string,
  opts: PromptOptions,
): Promise<PromptAnswerT> {
  const useTools = opts.useTools !== false;
  const helpCache = new Map<string, string>();
  const tone = opts.tone ?? "default";

  // Answer-cache check goes FIRST — before the targetCmd / ctx help
  // preload. Otherwise warm INTENT invocations still pay the full help-
  // fetch cost (man startup, shell lookup, etc.) per call even when the
  // answer is already cached. Key doesn't depend on help content so we
  // can compute it before any fetch.
  const cacheOpts = opts.cache ?? {};
  const provider = opts.cfg?.provider ?? "lm-studio";
  const base = opts.targetCmd
    ? `intent--${[opts.targetCmd.cmd, ...opts.targetCmd.args].join("_")}`
    : "lookup";
  const label = `${provider}--${base}`;
  const answerKey = cacheKey(
    [
      "prompt",
      provider,
      opts.cfg?.model ?? "",
      opts.cfg?.baseUrl ?? "",
      tone,
      useTools,
      question,
      Array.from(opts.ctx ?? []),
      opts.targetCmd ? [opts.targetCmd.cmd, ...opts.targetCmd.args] : null,
    ],
    label,
  );
  const cached = cacheRead(answerKey, cacheOpts);
  if (cached) {
    try {
      const parsed = PromptAnswer.parse(JSON.parse(cached));
      if (opts.debug) writeDebug(`cache hit: key=${answerKey}`);
      return parsed;
    } catch {
      // malformed cache entry → fall through to regenerate
    }
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPromptFor(tone, Boolean(opts.targetCmd)) },
    { role: "user", content: question },
  ];

  // INTENT モード: 使用するコマンドが確定しているので、そのヘルプを事前注入し
  // システム指示で「このコマンドを使え」と明示する。
  if (opts.targetCmd) {
    const { cmd, args } = opts.targetCmd;
    const result = await runGetHelp(cmd, args, "auto", helpCache);
    if (opts.debug) writeDebug(`target cmd: ${[cmd, ...args].join(" ")} → ${result.length} chars`);
    const lbl = [cmd, ...args].join(" ");
    messages.push({
      role: "system",
      content: `ユーザーは **${lbl}** を使う前提で質問しています。
他のコマンドで代替提案しないこと（どうしても不適切な場合のみ caveats で言及）。
以下が ${lbl} のヘルプ本文です:
${result}`,
    });
  }

  // --ctx で指定されたコマンドのヘルプを事前注入（ツール呼び出し数を削減）
  if (opts.ctx && opts.ctx.length > 0) {
    for (const cmd of opts.ctx) {
      const result = await runGetHelp(cmd, [], "auto", helpCache);
      if (opts.debug) writeDebug(`preloaded ${cmd} → ${result.length} chars`);
      messages.push({
        role: "system",
        content: `参考情報（事前ロード: ${cmd} のヘルプ）:\n${result}`,
      });
    }
  }

  const spinner = new ThinkingSpinner();
  spinner.start("コマンド考案中");
  try {
    const { parsed } = await dora.structured(messages, {
      schema: PromptAnswer,
      schemaName: "command_suggestion",
      tools: useTools ? [TOOL_GET_HELP] : undefined,
      handleTool: useTools ? (call) => handleToolCall(call, helpCache, opts.debug) : undefined,
      maxToolCalls: opts.maxToolCalls,
      debug: opts.debug
        ? {
            onStart: (i) =>
              writeDebug(`chat start model=${i.model} messages=${i.messages.length} tools=${i.tools ?? 0}`),
            onTokenStats: (s) =>
              writeDebug(
                `chat done tokens=${s.completionTokens ?? "?"}/${s.totalTokens ?? "?"} in=${s.elapsedMs}ms`,
              ),
            onToolCall: (c) => writeDebug(`[tool] ${c.name}(${c.args}) → ${c.resultChars} chars`),
          }
        : undefined,
    });

    cacheWrite(answerKey, JSON.stringify(parsed), cacheOpts);
    if (opts.debug) writeDebug(`cached: key=${answerKey}`);
    return parsed;
  } finally {
    spinner.stop();
  }
}

async function handleToolCall(
  call: { function: { name: string; arguments: string } },
  cache: Map<string, string>,
  debug?: boolean,
): Promise<string> {
  if (call.function.name !== "get_help") {
    return JSON.stringify({ error: `unknown tool: ${call.function.name}` });
  }
  let parsed: ToolCallArgs;
  try {
    parsed = JSON.parse(call.function.arguments) as ToolCallArgs;
  } catch {
    return JSON.stringify({ error: "invalid tool arguments" });
  }
  const cmd = typeof parsed.cmd === "string" ? parsed.cmd : "";
  const args = Array.isArray(parsed.args)
    ? parsed.args.filter((a): a is string => typeof a === "string")
    : [];
  const sourceRaw = typeof parsed.source === "string" ? parsed.source : "auto";
  const source: "auto" | "help" | "man" =
    sourceRaw === "help" || sourceRaw === "man" ? sourceRaw : "auto";

  if (!cmd) return JSON.stringify({ error: "cmd is required" });
  if (debug) writeDebug(`tool call: get_help cmd=${cmd} args=[${args.join(",")}] source=${source}`);

  return runGetHelp(cmd, args, source, cache);
}

async function runGetHelp(
  cmd: string,
  args: readonly string[],
  source: "auto" | "help" | "man",
  cache: Map<string, string>,
): Promise<string> {
  const key = JSON.stringify([cmd, args, source]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const result = await fetchHelp(cmd, args, { source });
    const out = JSON.stringify({
      cmd: result.cmd,
      args: result.args,
      source: result.source,
      text: result.text,
    });
    cache.set(key, out);
    return out;
  } catch (e) {
    const err =
      e instanceof CommandNotFoundError
        ? { error: "command_not_found", cmd }
        : e instanceof HelpNotFoundError
        ? { error: "help_not_available", cmd }
        : { error: "fetch_failed", cmd, message: (e as Error).message };
    const out = JSON.stringify(err);
    cache.set(key, out);
    return out;
  }
}

export function renderAnswer(ans: PromptAnswerT): void {
  writeCommandBox(ans.command);
  writeLine();
  writeLine(ans.explanation);
  if (ans.caveats.length > 0) {
    writeLine();
    for (const c of ans.caveats) writeCaveat(c);
  }
  if (ans.alternatives.length > 0) {
    writeLine();
    writeDim("代替案:");
    for (const alt of ans.alternatives) {
      writeLine(`  ${pc.cyan(alt.command)}`);
      writeLine(`    ${pc.dim(alt.when)}`);
    }
  }
  if (ans.sources.length > 0) {
    writeLine();
    writeDim(`参照: ${ans.sources.join(", ")}`);
  }
}
