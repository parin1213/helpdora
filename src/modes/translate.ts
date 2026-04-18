import type { Dora } from "../llm.js";
import type { Config } from "../config.js";
import type { HelpResult } from "../help-fetcher.js";
import { fetchHelp } from "../help-fetcher.js";
import { streamRaw, isSupportedModel } from "../llm-raw.js";
import { writeChunk, writeDebug, writeDim, writeLine, writeReasoningChunk, writeReasoningEnd } from "../render.js";
import { MarkdownStream } from "../stream-md.js";

const SYSTEM_PROMPT = `あなたは Unix/Linux/macOS コマンドに精通した翻訳者です。
与えられた英語のヘルプテキストの **すべての説明文を日本語に翻訳** してください。英語をそのまま残すのは不可。

翻訳ルール:
- オプション名（-x, --xxx）、サブコマンド、パス、URL、${"`"}code${"`"}、${"`"}identifier${"`"}、デフォルト値 ("HEAD" 等) は **原文のまま** 残す
- それ以外の説明文（自然言語部分）は **全て日本語化**
- **全てのオプション** を訳出、省略しない

簡潔化ルール（重要）:
- **原文にないセクション（DESCRIPTION / EXAMPLES 等）を勝手に追加しない**
- **同じ内容を二重化しない**（Arguments と Options で重複して書かない、要約段落 + 詳細 の二段構えをしない）
- 体言止め・短文優先（「〜する」を「〜」に、「〜する機能」を「〜機能」に）
- 推測注記（「[要確認]」等）は **書かない**

出力形式:
- 原文の見出し構造（Usage/Arguments/Options 等）をそのまま Markdown 見出しとして使う
- オプション一覧は **リスト形式**: ${"`"}- \`フラグ\`: 日本語説明${"`"} 1 行 1 項目
- オプションが 15 以上かつ説明が長い場合のみ Markdown 表
- 原文に使用例があれば残す、**なければ追加しない**`;

export interface TranslateOptions {
  man?: boolean;
  raw?: boolean;
  stream?: boolean;
  debug?: boolean;
  bypassThinking?: boolean;
}

export async function translate(
  dora: Dora,
  cfg: Config,
  cmd: string,
  args: readonly string[],
  opts: TranslateOptions,
): Promise<void> {
  const t0 = Date.now();
  const help = await fetchHelp(cmd, args, { source: opts.man ? "man" : "auto" });
  const fetchedIn = Date.now() - t0;

  if (opts.debug) {
    writeDebug(`help source=${help.source} bytes=${Buffer.byteLength(help.text, "utf8")} fetched_in=${fetchedIn}ms`);
  }

  writeDim(`# ${[cmd, ...args].join(" ")} — 翻訳 (source: ${help.source})`);
  writeLine();

  const user = userPrompt(help);
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: user },
  ];

  const useBypass = (opts.bypassThinking ?? true) && isSupportedModel(cfg.model);
  if (opts.debug) {
    writeDebug(`thinking bypass: ${useBypass ? "on (qwen raw completions)" : "off (chat completions)"}`);
  }

  // When --raw is on, keep Markdown source plain so the原文 section is compared apples-to-apples.
  const prettyMd = !opts.raw;
  const md = prettyMd ? new MarkdownStream() : null;
  const emitChunk = (s: string): void => {
    if (md) md.write(s);
    else writeChunk(s);
  };
  const finishContent = (): void => {
    if (md) md.end();
    else writeLine();
  };

  if (useBypass) {
    let all = "";
    const t0 = Date.now();
    let tokens = 0;
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
      if (opts.stream === false) all += chunk;
      else emitChunk(chunk);
    }
    if (opts.stream === false) emitChunk(all);
    finishContent();
    if (opts.debug) writeDebug(`total tokens=${tokens} elapsed=${Date.now() - t0}ms`);
  } else {
    let contentStarted = false;
    let reasoningStarted = false;
    if (opts.stream === false) {
      let all = "";
      for await (const ev of dora.streamChat(messages, debugHook(opts.debug))) {
        if (ev.kind === "content") all += ev.text;
      }
      emitChunk(all);
      finishContent();
    } else {
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
  }

  if (opts.raw) {
    writeLine();
    writeDim("--- 原文 ---");
    writeLine(help.text);
  }
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
        writeDebug(
          `chat done tokens=${s.completionTokens ?? "?"}/${s.totalTokens ?? "?"} in=${s.elapsedMs}ms tps=${
            s.completionTokens && s.elapsedMs ? ((s.completionTokens / s.elapsedMs) * 1000).toFixed(1) : "?"
          }`,
        ),
    },
  };
}
