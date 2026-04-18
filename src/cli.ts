import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ConfigOverrides } from "./config.js";

// Graceful exit when downstream (e.g. `less` closing on `q`) breaks the
// pipe. Without this, any in-flight process.stdout.write() throws EPIPE
// and crashes Node with a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
process.stderr.on("error", () => {
  /* same reason; silent */
});
import { Dora } from "./llm.js";
import { translate } from "./modes/translate.js";
import { promptMode, renderAnswer } from "./modes/prompt.js";
import { installSkill } from "./modes/install-skill.js";
import { CommandNotFoundError, HelpNotFoundError } from "./help-fetcher.js";
import { writeError } from "./render.js";

interface RootOptions {
  prompt?: string;
  man?: boolean;
  raw?: boolean;
  stream?: boolean;
  debug?: boolean;
  model?: string;
  baseUrl?: string;
  ctx?: string[];
  tools?: boolean;
  maxToolCalls?: string;
  thinkBypass?: boolean;
  dora?: boolean;
  cache?: boolean;
  refresh?: boolean;
}

const program = new Command();

program
  .name("dora")
  .description("コマンドの --help / man を日本語訳、または自然言語からコマンドを逆引きする CLI (LM Studio 互換)")
  .version(readVersion(), "-V, --version", "バージョンを表示")
  .helpOption("-h, --help", "このヘルプを表示")
  .argument("[cmd-and-args...]", "翻訳対象のコマンドと引数 (例: `dora git commit`)")
  .option("-p, --prompt <question>", "自然言語の質問からコマンドを逆引きする")
  .option("--man", "ヘルプ取得元を `man` に強制")
  .option("--raw", "翻訳の下に原文も併記")
  .addOption(new Option("--no-stream", "ストリーミングを無効化 (パイプ用途)"))
  .option("--debug", "デバッグ情報 (タイミング、トークン数、ツール呼び出し) を stderr へ")
  .option("--model <id>", "モデル ID を上書き (例: gpt-oss-20b)")
  .option("--base-url <url>", "OpenAI 互換エンドポイントを上書き")
  .option("--ctx <cmd>", "-p モードで事前注入するコマンドのヘルプ (複数指定可)", collect, [])
  .addOption(new Option("--no-tools", "-p モードで LLM のツール呼び出しを無効化"))
  .option("--max-tool-calls <n>", "-p モードでのツール呼び出し上限", "4")
  .addOption(new Option("--no-think-bypass", "翻訳モードで /v1/completions 経由の思考バイパスを無効化"))
  .option("--dora", "ドラえもん口調で出力する")
  .addOption(new Option("--no-cache", "キャッシュを一切使わない（読み書きとも無効）"))
  .option("--refresh", "キャッシュを無視してLLMを再実行し、結果を上書き保存")
  .action(async (cmdAndArgs: string[], opts: RootOptions) => {
    await runRoot(cmdAndArgs, opts);
  });

program
  .command("install-skill")
  .description("Claude Code 用のスキルファイル (~/.claude/skills/dora/SKILL.md) をインストール")
  .option("-f, --force", "既存ファイルを上書きする")
  .option("--dir <path>", "スキルをインストールするディレクトリを上書き (default: ~/.claude/skills)")
  .action((o: { force?: boolean; dir?: string }) => {
    const code = installSkill(o);
    process.exit(code);
  });

program
  .command("cache")
  .argument("<action>", "list | clear | path")
  .description("LLM レスポンスキャッシュ (~/.cache/dora) の管理")
  .action(async (action: string) => {
    const { cacheList, cacheClear, cachePath } = await import("./cache.js");
    if (action === "path") {
      process.stdout.write(cachePath() + "\n");
      return;
    }
    if (action === "list") {
      const entries = cacheList();
      if (entries.length === 0) {
        process.stdout.write("(empty)\n");
        return;
      }
      const total = entries.reduce((a, e) => a + e.bytes, 0);
      for (const e of entries) {
        process.stdout.write(`${e.mtime.toISOString()}  ${String(e.bytes).padStart(6)} B  ${e.key}\n`);
      }
      process.stdout.write(`---\ntotal: ${entries.length} entries, ${total} bytes\n`);
      return;
    }
    if (action === "clear") {
      const n = cacheClear();
      process.stdout.write(`removed ${n} entries\n`);
      return;
    }
    writeError(`unknown action: ${action} (expected: list | clear | path)`);
    process.exit(64);
  });

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

async function runRoot(cmdAndArgs: string[], opts: RootOptions): Promise<void> {
  const cliCfg: ConfigOverrides = {};
  if (opts.model) cliCfg.model = opts.model;
  if (opts.baseUrl) cliCfg.baseUrl = opts.baseUrl;

  const cfg = loadConfig(cliCfg);
  const dora = new Dora(cfg);

  const maxToolCalls = Number(opts.maxToolCalls ?? "4");

  try {
    if (opts.prompt) {
      if (cmdAndArgs.length > 0) {
        writeError("-p と <cmd> は同時に指定できません");
        process.exit(64);
      }
      const ans = await promptMode(dora, opts.prompt, {
        useTools: opts.tools !== false,
        maxToolCalls: Number.isFinite(maxToolCalls) && maxToolCalls > 0 ? maxToolCalls : 4,
        ctx: opts.ctx,
        debug: opts.debug,
        tone: opts.dora ? "dora" : "default",
        cache: { disabled: opts.cache === false, refresh: opts.refresh },
        cfg,
      });
      renderAnswer(ans);
      return;
    }

    if (cmdAndArgs.length === 0) {
      program.outputHelp();
      return;
    }

    const [cmd, ...rest] = cmdAndArgs;
    if (!cmd) {
      program.outputHelp();
      return;
    }
    await translate(dora, cfg, cmd, rest, {
      man: opts.man,
      raw: opts.raw,
      stream: opts.stream,
      debug: opts.debug,
      bypassThinking: opts.thinkBypass,
      tone: opts.dora ? "dora" : "default",
      cache: { disabled: opts.cache === false, refresh: opts.refresh },
    });
  } catch (e) {
    handleError(e);
  }
}

function handleError(e: unknown): never {
  if (e instanceof CommandNotFoundError) {
    writeError(`コマンドが見つかりません: ${e.cmd}`);
    process.exit(1);
  }
  if (e instanceof HelpNotFoundError) {
    writeError(`ヘルプを取得できませんでした: ${e.cmd}`);
    process.exit(1);
  }
  const err = e as { code?: string; status?: number; message?: string; cause?: { code?: string } };
  if (err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
    writeError(`LM Studio サーバに接続できません。\`lms server start\` を実行するか、--base-url を確認してください。`);
    process.exit(2);
  }
  if (err.status === 404) {
    writeError(`モデルが見つかりません。--model で既存モデル ID を指定するか \`lms ps\` でロード状況を確認してください。`);
    process.exit(2);
  }
  writeError(err.message ?? String(e));
  process.exit(3);
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dev: src/cli.ts → ../package.json, built: dist/cli.js → ../package.json
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

program.parseAsync().catch((e) => handleError(e));
