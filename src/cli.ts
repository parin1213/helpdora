import { Command, Option } from "commander";
import pc from "picocolors";
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
import { summary, writeSummaryFooter, EmptyResponseError } from "./modes/summary.js";
import { promptMode, renderAnswer } from "./modes/prompt.js";
import { installSkill } from "./modes/install-skill.js";
import { precache, type Variant } from "./modes/precache.js";
import { completion } from "./modes/completion.js";
import { CommandNotFoundError, HelpNotFoundError } from "./help-fetcher.js";
import { detectMode, ArgError, type Mode } from "./mode-detect.js";
import { writeError } from "./render.js";

type RootOptions = {
  prompt?: string;
  man?: boolean;
  raw?: boolean;
  stream?: boolean;
  debug?: boolean;
  model?: string;
  baseUrl?: string;
  provider?: string;
  ctx?: string[];
  tools?: boolean;
  maxToolCalls?: string;
  thinkBypass?: boolean;
  dora?: boolean;
  cache?: boolean;
  refresh?: boolean;
  full?: boolean;
};

const program = new Command();

program
  .name("dora")
  .description("コマンドの要点・使い方・逆引きを日本語で返す CLI (LM Studio 互換)")
  .version(readVersion(), "-V, --version", "バージョンを表示")
  .helpOption("-h, --help", "このヘルプを表示")
  .argument(
    "[args...]",
    "コマンド名 or 自然言語の要望 (例: `dora ls`, `dora git \"直前のコミット取り消し\"`, `dora \"tarで解凍\"`)",
  )
  .option("-p, --prompt <question>", "自然言語の質問からコマンドを逆引き (LOOKUP モードを明示)")
  .option("--full", "全オプションを逐語訳する FULL モード")
  .option("--man", "ヘルプ取得元を `man` に強制")
  .option("--raw", "翻訳の下に原文も併記 (FULL/SUMMARY のみ)")
  .addOption(new Option("--no-stream", "ストリーミングを無効化 (パイプ用途)"))
  .option("--debug", "デバッグ情報 (タイミング、トークン数、ツール呼び出し) を stderr へ")
  .option("--model <id>", "モデル ID を上書き (例: gpt-oss-20b)")
  .option("--base-url <url>", "OpenAI 互換エンドポイントを上書き")
  .option("--provider <name>", "lm-studio | claude | codex (default: lm-studio)")
  .option("--ctx <cmd>", "LOOKUP/INTENT で事前注入するコマンドのヘルプ (複数指定可)", collect, [])
  .addOption(new Option("--no-tools", "LOOKUP/INTENT で LLM のツール呼び出しを無効化"))
  .option("--max-tool-calls <n>", "LOOKUP/INTENT でのツール呼び出し上限", "4")
  .addOption(new Option("--no-think-bypass", "SUMMARY/FULL で /v1/completions 経由の思考バイパスを無効化"))
  .option("--dora", "ドラえもん口調で出力する")
  .addOption(new Option("--no-cache", "キャッシュを一切使わない（読み書きとも無効）"))
  .option("--refresh", "キャッシュを無視してLLMを再実行し、結果を上書き保存")
  .action(async (args: string[], opts: RootOptions) => {
    await runRoot(args, opts);
  });

program
  .command("completion")
  .argument("<shell>", "zsh")
  .description("シェル補完スクリプトを標準出力に出す (現状 zsh のみ対応)")
  .allowExcessArguments(false)
  .action((shell: string) => {
    process.exit(completion(shell));
  });

program
  .command("install-skill")
  .description("Claude Code 用のスキルファイル (~/.claude/skills/dora/SKILL.md) をインストール")
  .option("-f, --force", "既存ファイルを上書きする")
  .option("--dir <path>", "スキルをインストールするディレクトリを上書き (default: ~/.claude/skills)")
  .allowExcessArguments(false)
  .action((o: { force?: boolean; dir?: string }) => {
    const code = installSkill(o);
    process.exit(code);
  });

program
  .command("precache")
  .argument(
    "[cmd-and-args...]",
    "直接キャッシュ対象を指定 (例: `dora precache pup`, `dora precache git diff`)。" +
      "指定時は履歴スキャンをスキップ。top-level のみ指定なら --auto-subs で sub も自動追加",
  )
  .description(
    "シェル履歴からトレンドのコマンドを抽出して事前キャッシュ、" +
      "または位置引数で対象を直接指定。" +
      "root の --provider / --model / --base-url を継承するので、" +
      "`dora --provider claude precache` のように書いて別プロバイダで事前キャッシュできる",
  )
  .option("-y, --yes", "履歴読み取りと時間確認を自動承認")
  .option("--dry-run", "一覧のみ表示、キャッシュしない")
  .option("--limit <n>", "キャッシュする最大件数", (v) => parseInt(v, 10))
  .option("--min-count <n>", "トップレベルコマンドの最低出現回数 (default: 3)", (v) => parseInt(v, 10))
  .option("--pair-min-count <n>", "サブコマンド pair の最低出現回数 (default: 2)", (v) => parseInt(v, 10))
  .option("--threshold <min>", "総推定 N 分超で -y 必須 (default: 2)", (v) => parseFloat(v))
  .option("--auto-subs <n>", "各 top-level cmd の --help から検出する sub の最大数 (default: 8、0 で無効)", (v) => parseInt(v, 10))
  .option("--history-file <path>", "読み取る履歴ファイルを上書き (default: $HISTFILE or ~/.zsh_history)")
  // NOTE: `--dora` / `--full` already exist on the root command and would
  // be absorbed by commander before reaching this subcommand. Use
  // `--tone` / `--mode` instead.
  .option("--tone <name>", "トーン: default | dora (default: default)", "default")
  .option("--mode <name>", "モード: summary | full (default: summary)", "summary")
  .option("--all", "default/dora × summary/full の 4 variants すべてキャッシュ (--tone/--mode を上書き)")
  .allowUnknownOption(false)
  .action(async (
    cmdAndArgs: string[],
    o: {
      yes?: boolean;
      dryRun?: boolean;
      limit?: number;
      minCount?: number;
      pairMinCount?: number;
      threshold?: number;
      autoSubs?: number;
      historyFile?: string;
      tone?: string;
      mode?: string;
      all?: boolean;
    },
    cmd: Command,
  ) => {
    // Root-level `--dora` / `--full` would silently be absorbed because
    // they're declared on the root command too. Detect the misuse and tell
    // the user the right flag on precache.
    const root = cmd.parent?.opts() as {
      dora?: boolean;
      full?: boolean;
      provider?: string;
      model?: string;
      baseUrl?: string;
    } | undefined;
    if (root?.dora) {
      writeError(`precache では --dora ではなく ${pc.bold("--tone dora")} を使います`);
      process.exit(64);
    }
    if (root?.full) {
      writeError(`precache では --full ではなく ${pc.bold("--mode full")} を使います`);
      process.exit(64);
    }
    // Build the variants list:
    //   (none)               → summary/default
    //   --tone dora          → summary/dora
    //   --mode full          → full/default
    //   --tone dora --mode full → full/dora
    //   --all                → all 4
    let variants: Variant[];
    if (o.all) {
      variants = [
        { mode: "summary", tone: "default" },
        { mode: "summary", tone: "dora" },
        { mode: "full", tone: "default" },
        { mode: "full", tone: "dora" },
      ];
    } else {
      const tone = o.tone;
      const mode = o.mode;
      if (tone !== "default" && tone !== "dora") {
        writeError(`--tone は 'default' か 'dora' のみ指定できます (got: ${tone})`);
        process.exit(64);
      }
      if (mode !== "summary" && mode !== "full") {
        writeError(`--mode は 'summary' か 'full' のみ指定できます (got: ${mode})`);
        process.exit(64);
      }
      variants = [{ mode, tone }];
    }
    // Inherit root-level --provider / --model / --base-url so
    // `dora --provider claude precache` behaves as expected.
    const cliCfg: ConfigOverrides = {};
    if (root?.provider) {
      if (root.provider !== "lm-studio" && root.provider !== "claude" && root.provider !== "codex") {
        writeError(`--provider は lm-studio | claude | codex のみ (got: ${root.provider})`);
        process.exit(64);
      }
      cliCfg.provider = root.provider;
    }
    if (root?.model) cliCfg.model = root.model;
    if (root?.baseUrl) cliCfg.baseUrl = root.baseUrl;
    const cfg = loadConfig(cliCfg);
    const dora = new Dora(cfg);
    try {
      const code = await precache(dora, cfg, {
        assumeYes: o.yes,
        dryRun: o.dryRun,
        limit: o.limit,
        minCount: o.minCount,
        pairMinCount: o.pairMinCount,
        thresholdMinutes: o.threshold,
        autoSubs: o.autoSubs,
        historyFile: o.historyFile,
        directArgs: cmdAndArgs && cmdAndArgs.length > 0 ? cmdAndArgs : undefined,
        variants,
      });
      process.exit(code);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("cache")
  .argument("<action>", "list | clear | path")
  .argument("[pattern]", "clear/list で部分一致フィルタ (例: `rg`, `summary--git`)")
  .description("LLM レスポンスキャッシュ (~/.cache/dora) の管理")
  .allowExcessArguments(false)
  .action(async (action: string, pattern: string | undefined) => {
    const { cacheList, cacheClear, cachePath } = await import("./cache.js");
    if (action === "path") {
      if (pattern) {
        writeError("`cache path` は引数を取りません");
        process.exit(64);
      }
      process.stdout.write(cachePath() + "\n");
      return;
    }
    if (action === "list") {
      const all = cacheList();
      const entries = pattern ? all.filter((e) => e.key.includes(pattern)) : all;
      if (entries.length === 0) {
        if (pattern) {
          writeError(`\`${pattern}\` に一致するキャッシュエントリがありません`);
          process.exit(1);
        }
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
      const beforeAll = cacheList();
      if (pattern) {
        const matched = beforeAll.filter((e) => e.key.includes(pattern));
        if (matched.length === 0) {
          writeError(`\`${pattern}\` に一致するキャッシュエントリがありません`);
          process.exit(1);
        }
      }
      const n = cacheClear(pattern);
      process.stdout.write(`removed ${n} entries${pattern ? ` (pattern: ${pattern})` : ""}\n`);
      return;
    }
    writeError(`unknown action: ${action} (expected: list | clear | path)`);
    process.exit(64);
  });

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

async function runRoot(args: string[], opts: RootOptions): Promise<void> {
  const cliCfg: ConfigOverrides = {};
  if (opts.model) cliCfg.model = opts.model;
  if (opts.baseUrl) cliCfg.baseUrl = opts.baseUrl;
  if (opts.provider) {
    if (opts.provider !== "lm-studio" && opts.provider !== "claude" && opts.provider !== "codex") {
      writeError(`--provider は lm-studio | claude | codex のみ (got: ${opts.provider})`);
      process.exit(64);
    }
    cliCfg.provider = opts.provider;
  }

  const cfg = loadConfig(cliCfg);
  const dora = new Dora(cfg);

  const maxToolCalls = Number(opts.maxToolCalls ?? "4");
  const tone = opts.dora ? "dora" : "default";
  const cacheOpt = { disabled: opts.cache === false, refresh: opts.refresh };

  let mode: Mode;
  try {
    mode = await detectMode(args, opts);
  } catch (e) {
    if (e instanceof ArgError) {
      writeError(e.message);
      process.exit(64);
    }
    handleError(e);
  }

  try {
    switch (mode.kind) {
      case "help":
        program.outputHelp();
        return;

      case "lookup": {
        const ans = await promptMode(dora, mode.intent, {
          useTools: opts.tools !== false,
          maxToolCalls: Number.isFinite(maxToolCalls) && maxToolCalls > 0 ? maxToolCalls : 4,
          ctx: opts.ctx,
          debug: opts.debug,
          tone,
          cache: cacheOpt,
          cfg,
        });
        renderAnswer(ans);
        return;
      }

      case "intent": {
        const ans = await promptMode(dora, mode.intent, {
          useTools: opts.tools !== false,
          maxToolCalls: Number.isFinite(maxToolCalls) && maxToolCalls > 0 ? maxToolCalls : 4,
          ctx: opts.ctx,
          debug: opts.debug,
          tone,
          cache: cacheOpt,
          cfg,
          targetCmd: { cmd: mode.cmd, args: mode.args },
        });
        renderAnswer(ans);
        return;
      }

      case "summary": {
        await summary(dora, cfg, mode.cmd, mode.args, {
          man: opts.man,
          raw: opts.raw,
          stream: opts.stream,
          debug: opts.debug,
          bypassThinking: opts.thinkBypass,
          tone,
          cache: cacheOpt,
        });
        writeSummaryFooter(mode.cmd, mode.args);
        return;
      }

      case "full":
        await translate(dora, cfg, mode.cmd, mode.args, {
          man: opts.man,
          raw: opts.raw,
          stream: opts.stream,
          debug: opts.debug,
          bypassThinking: opts.thinkBypass,
          tone,
          cache: cacheOpt,
        });
        return;
    }
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
  if (e instanceof EmptyResponseError) {
    writeError(e.message);
    process.exit(2);
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
