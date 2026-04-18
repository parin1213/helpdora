import type { Dora } from "../llm.js";
import type { Config } from "../config.js";
import type { HelpResult } from "../help-fetcher.js";
import { fetchHelp } from "../help-fetcher.js";
import { streamRaw, isSupportedModel } from "../llm-raw.js";
import { writeChunk, writeDebug, writeDim, writeLine, writeReasoningChunk, writeReasoningEnd } from "../render.js";
import { MarkdownStream } from "../stream-md.js";
import { cacheKey, cacheRead, cacheWrite, type CacheOptions } from "../cache.js";

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

const DORA_TONE_APPEND = `

# 口調指定: ドラえもん
すべての日本語の説明文を、アニメ「ドラえもん」のドラえもんの口調で書き換えてください。

語彙と一人称:
- 一人称は「ぼく」、二人称は「きみ」（ユーザーを呼び掛ける場面でのみ使う）
- 丁寧すぎず、子供にも分かる親しみやすい言葉を選ぶ（「実行する」→「動かすんだ」、「指定する」→「決めるんだよ」など）
- 「バカだなあ」「やれやれ」「どうしたの？」など、ドラえもん独特のやわらかい呼び掛けは自然な位置で挟んでよい（多用しすぎない、1〜2個/出力）

文末（語尾）:
- 「〜だよ」「〜なんだ」「〜のさ」「〜ね」「〜しよう」「〜するんだ」「〜だぜ」など、親しみやすい文末を使う
- 「です・ます」「〜である」「〜します」は使わない
- 体言止めも時々使ってOK

その他:
- オプション名・コマンド名・コードブロック・URL・identifier は原文のまま（口調変換の対象外）
- 絵文字は使わない（フォント差異でズレるため）
- 「やれやれ、…出すか。」のような「何かを取り出すよ」という秘密道具的な言い回しをセクション冒頭で1回だけ使ってよい（ただし自然な文脈で）`;

function systemPromptFor(tone: "default" | "dora" | undefined): string {
  return tone === "dora" ? SYSTEM_PROMPT + DORA_TONE_APPEND : SYSTEM_PROMPT;
}

export interface TranslateOptions {
  man?: boolean;
  raw?: boolean;
  stream?: boolean;
  debug?: boolean;
  bypassThinking?: boolean;
  tone?: "default" | "dora";
  cache?: CacheOptions;
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

  const tone = opts.tone ?? "default";
  const systemPrompt = systemPromptFor(tone);
  const user = userPrompt(help);
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: user },
  ];

  const useBypass = (opts.bypassThinking ?? true) && isSupportedModel(cfg.model);
  const cacheK = cacheKey([
    "translate",
    cfg.model,
    cfg.baseUrl,
    tone,
    useBypass,
    help.source,
    help.text,
  ]);
  const cacheOpts = opts.cache ?? {};

  // Cache hit: render the cached Markdown through the usual pipeline so
  // the user still gets nice ANSI formatting but skips the LLM round-trip.
  const hit = cacheRead(cacheK, cacheOpts);
  const header = `# ${[cmd, ...args].join(" ")} — 翻訳 (source: ${help.source}${hit ? ", cached" : ""})`;
  writeDim(header);
  writeLine();

  if (hit) {
    if (opts.debug) writeDebug(`cache hit: key=${cacheK} bytes=${hit.length}`);
    renderMarkdown(hit, opts);
    if (opts.raw) appendRaw(help.text);
    return;
  }

  if (opts.debug) {
    writeDebug(`thinking bypass: ${useBypass ? "on (qwen raw completions)" : "off (chat completions)"} | tone=${tone}`);
  }

  // Stream, but accumulate so we can cache the final Markdown.
  const prettyMd = !opts.raw;
  const md = prettyMd ? new MarkdownStream() : null;
  let accumulator = "";
  const emitChunk = (s: string): void => {
    accumulator += s;
    if (opts.stream === false) return;
    if (md) md.write(s);
    else writeChunk(s);
  };
  const finishContent = (): void => {
    if (opts.stream === false) {
      // batch mode: render the whole thing now
      if (md) md.write(accumulator);
      else writeChunk(accumulator);
    }
    if (md) md.end();
    else writeLine();
  };

  if (useBypass) {
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
      emitChunk(chunk);
    }
    finishContent();
    if (opts.debug) writeDebug(`total tokens=${tokens} elapsed=${Date.now() - t0}ms`);
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

  if (accumulator.trim().length > 30) {
    cacheWrite(cacheK, accumulator, cacheOpts);
    if (opts.debug) writeDebug(`cached: key=${cacheK} bytes=${accumulator.length}`);
  }

  if (opts.raw) appendRaw(help.text);
}

function renderMarkdown(content: string, opts: TranslateOptions): void {
  if (opts.raw) {
    writeChunk(content);
    if (!content.endsWith("\n")) writeLine();
    return;
  }
  const md = new MarkdownStream();
  md.write(content);
  md.end();
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
        writeDebug(
          `chat done tokens=${s.completionTokens ?? "?"}/${s.totalTokens ?? "?"} in=${s.elapsedMs}ms tps=${
            s.completionTokens && s.elapsedMs ? ((s.completionTokens / s.elapsedMs) * 1000).toFixed(1) : "?"
          }`,
        ),
    },
  };
}
