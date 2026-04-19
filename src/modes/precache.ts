// Precache: scan shell history for frequently-used commands and populate
// the SUMMARY cache for them. Useful before going offline / before a demo /
// before iterating on prompts (so the first real invocation is instant).
//
// Privacy: shell history is private by design. This module NEVER reads
// the history file without the user saying yes first (interactive prompt,
// or `--yes` on the CLI). The file path is shown up front so the user
// can see exactly what will be scanned.
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import type { Dora } from "../llm.js";
import type { Config } from "../config.js";
import { summary } from "./summary.js";
import { translate } from "./translate.js";
import { isCommandAvailable } from "../command-exists.js";
import { fetchHelp } from "../help-fetcher.js";
import { writeLine, writeDim, writeError } from "../render.js";

const SKIP = new Set([
  "cd", "echo", "export", "alias", "unalias", "source", "set", "unset",
  "true", "false", ":", ".", "pwd", "exit", "clear", "history", "type",
  "which", "command", "eval", "exec", "read", "printf", "time", "builtin",
  "function", "return", "local", "declare", "typeset", "readonly", "hash",
  "dora",
]);

export interface PrecacheOptions {
  historyFile?: string;
  limit?: number;
  /** Minimum frequency for top-level commands (default 3). */
  minCount?: number;
  /** Minimum frequency for (cmd, sub) pairs (default 2). */
  pairMinCount?: number;
  /** Require this many distinct subcommands observed before treating as
   *  subcommand-shaped (default 3). */
  pairDistinctSubs?: number;
  /** Cache a specific command (+ optional sub-args) instead of scanning
   *  history. Skips the history-permission prompt. If the args list has
   *  only a top-level cmd, auto-subs are still appended (subject to
   *  autoSubs). */
  directArgs?: readonly string[];
  dryRun?: boolean;
  /** Which (mode, tone) variants to cache per command.
   *  - default: [{mode:"summary", tone:"default"}]
   *  - --dora: adds {mode:"summary", tone:"dora"}
   *  - --full: switches to {mode:"full", tone:"default"} (default summary dropped)
   *  - --all: all 4 variants
   *  When both --full and --dora are given (without --all), caches full+dora only.
   */
  variants?: Variant[];
  /** Per top-level command, auto-add up to this many detected subcommands
   *  from `<cmd> --help` parsing. 0 disables (default 8). */
  autoSubs?: number;
  /** Skip history-access prompt + time-estimate prompt. */
  assumeYes?: boolean;
  /** Ask-for-confirmation threshold in minutes (default 2). */
  thresholdMinutes?: number;
}

export type Variant = { mode: "summary" | "full"; tone: "default" | "dora" };

export function variantLabel(v: Variant): string {
  return `${v.mode}/${v.tone}`;
}

// Per-variant rough time-per-item for the pre-run estimate. FULL outputs
// are longer so they take ~2x the token budget. Same tone doesn't change
// speed meaningfully.
const VARIANT_SECS: Record<string, number> = {
  "summary/default": 15,
  "summary/dora": 15,
  "full/default": 30,
  "full/dora": 30,
};

interface Candidate {
  cmd: string;
  args: string[];
  uses: number;
  label: string; // "git" / "git commit"
}

function parseZshHistory(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^:\s*\d+:\d+;(.*)$/);
    if (m) out.push(m[1]!);
    else if (line.trim() && !line.startsWith("#")) out.push(line);
  }
  return out;
}

function firstTokens(cmdline: string): string[] {
  const piece = cmdline.split(/[|;&]|\s&&\s|\s\|\|\s/)[0]!.trim();
  const tokens = piece.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (tokens[i] === "sudo" || /^[A-Z][A-Z0-9_]*=/.test(tokens[i]!))) i++;
  return tokens.slice(i, i + 4);
}

function isSubShaped(tok: string): boolean {
  if (!tok) return false;
  if (tok.startsWith("-") || tok.startsWith("/") || tok.includes("=") || tok.includes(":")) return false;
  return /^[a-z][a-zA-Z0-9_.-]{1,24}$/.test(tok);
}

function isCmdShaped(tok: string): boolean {
  return /^[A-Za-z0-9._+-]{1,30}$/.test(tok);
}

function defaultHistoryPath(): string {
  return process.env.HISTFILE || join(homedir(), ".zsh_history");
}

// Ask a yes/no. Works both on TTY (interactive prompt) and on piped stdin
// (e.g. `yes | dora precache`). Deliberately avoids `readline` because
// readline puts the terminal into raw mode, which combined with later
// async work caused zsh to suspend the process with SIGTTIN/SIGTTOU.
async function confirm(prompt: string): Promise<boolean> {
  if (process.stdin.isTTY) process.stdout.write(prompt);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: boolean): void => {
      if (done) return;
      done = true;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      resolve(val);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Piped input (e.g. `yes |`) arrives as "y\ny\ny\n...", so only
      // look at the first line instead of the whole buffer.
      const firstLine = (text.split(/\r?\n/)[0] ?? "").trim();
      finish(/^y(es)?$/i.test(firstLine));
    };
    const onEnd = (): void => finish(false);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}
function closeReadline(): void {
  // still useful as a finally-hook so stdin doesn't keep the event loop alive
  try {
    process.stdin.pause();
  } catch {
    /* best-effort */
  }
}

/**
 * Heuristic parse of `<cmd> --help` (and `<cmd> help -a` for git-like
 * tools) to extract subcommand names. Works for git / mise / docker /
 * kubectl / gh / npm / cargo / brew / gcloud / aws — roughly any tool
 * that lists subcommands under a "Commands:" / "SUBCOMMANDS:" section
 * or in the "git help -a" bare format.
 */
async function enumerateSubcommands(cmd: string): Promise<string[]> {
  const texts: string[] = [];
  const main = await fetchHelp(cmd, [], { source: "auto", timeoutMs: 4_000 }).catch(() => null);
  if (main) texts.push(main.text);

  // Some tools (git, gh) print only a short set in `--help` but a full set
  // via `<cmd> help -a` or `<cmd> commands`. Try these lightly and ignore
  // failures.
  for (const extra of [["help", "-a"], ["commands"]]) {
    const r = await fetchHelp(cmd, extra, { source: "auto", timeoutMs: 4_000 }).catch(() => null);
    if (r) texts.push(r.text);
  }

  const found = new Set<string>();
  for (const text of texts) {
    const lines = text.split("\n");
    let inSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      // Enter a subcommand section on common headings.
      if (
        /^(commands?|subcommands?|available commands|主な commands|core commands|main porcelain|ancillary commands|cli commands)[\s:]*$/i.test(
          trimmed,
        ) ||
        /^(Commands|Subcommands|COMMANDS|SUBCOMMANDS):/.test(trimmed)
      ) {
        inSection = true;
        continue;
      }
      if (inSection) {
        if (trimmed === "") {
          // blank line: end of current sub-section (but tolerate one blank)
          inSection = found.size > 0 ? false : inSection;
          continue;
        }
        // Indented line starting with a subcommand-shaped identifier,
        // followed by spaces then description. Examples:
        //   "  add        Add file contents to the index"
        //   "  commit     Record changes to the repository"
        //   "   checkout  ..."
        const m = line.match(/^\s{1,8}([a-z][a-z0-9_-]{1,24})\s{2,}\S/);
        if (m && m[1]) found.add(m[1]);
      } else {
        // Also catch bare 2-column listings from `git help -a` which has
        // no "Commands:" header — lines like "   add         Add file contents"
        const m = line.match(/^\s{2,}([a-z][a-z0-9_-]{2,24})\s{2,}[A-Za-z]/);
        if (m && m[1]) {
          // Only accept if the word looks like a real subcommand (not a
          // flag descriptor, not an option default). Skip common false
          // positives by requiring lowercase identifier shape.
          found.add(m[1]);
        }
      }
    }
  }

  // Remove obvious noise words that sneak through the parse.
  const NOISE = new Set([
    "options", "arguments", "usage", "examples", "environment", "description",
    "see", "also", "note", "notes", "version", "help", "global", "common",
    "flags", "default", "defaults",
  ]);
  return [...found].filter((s) => !NOISE.has(s));
}

async function discover(opts: PrecacheOptions): Promise<Candidate[]> {
  const path = opts.historyFile ?? defaultHistoryPath();
  if (!existsSync(path)) throw new Error(`history file not found: ${path}`);
  const lines = parseZshHistory(path);

  const cmdCount = new Map<string, number>();
  const subCount = new Map<string, Map<string, number>>();

  for (const line of lines) {
    const toks = firstTokens(line);
    const [c0, c1] = toks;
    if (!c0 || !isCmdShaped(c0) || SKIP.has(c0)) continue;
    cmdCount.set(c0, (cmdCount.get(c0) ?? 0) + 1);
    if (c1 && isSubShaped(c1)) {
      if (!subCount.has(c0)) subCount.set(c0, new Map());
      const m = subCount.get(c0)!;
      m.set(c1, (m.get(c1) ?? 0) + 1);
    }
  }

  const minCount = opts.minCount ?? 3;
  const pairMin = opts.pairMinCount ?? 2;
  const pairDistinct = opts.pairDistinctSubs ?? 3;

  // Gate on installed-ness so we don't try to fetch help for tools this
  // machine doesn't have.
  const cmdEntries = [...cmdCount.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1]);
  const availability = new Map<string, boolean>(
    await Promise.all(
      cmdEntries.map(async ([c]) => [c, await isCommandAvailable(c)] as [string, boolean]),
    ),
  );

  const topLevel: Candidate[] = [];
  for (const [cmd, uses] of cmdEntries) {
    if (!availability.get(cmd)) continue;
    topLevel.push({ cmd, args: [], uses, label: cmd });
  }

  const pairs: Candidate[] = [];
  for (const [cmd, subs] of subCount.entries()) {
    if (!availability.get(cmd)) continue;
    if (subs.size < pairDistinct) continue;
    for (const [sub, n] of subs.entries()) {
      if (n >= pairMin) pairs.push({ cmd, args: [sub], uses: n, label: `${cmd} ${sub}` });
    }
  }
  pairs.sort((a, b) => b.uses - a.uses);

  // Auto-detect subcommands from each top-level command's own help text.
  // Caps per top-level at `autoSubs` (default 8). History-observed subs
  // already present in `pairs` are skipped here to avoid duplicates.
  const autoSubs = opts.autoSubs ?? 8;
  const autoPairs: Candidate[] = [];
  if (autoSubs > 0) {
    const seenPair = new Set(pairs.map((p) => `${p.cmd}|${p.args[0]}`));
    for (const tl of topLevel) {
      const subs = await enumerateSubcommands(tl.cmd).catch(() => [] as string[]);
      let added = 0;
      for (const sub of subs) {
        if (added >= autoSubs) break;
        const key = `${tl.cmd}|${sub}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        // uses=0 signals "not in history, detected from help parse". Put
        // these after history pairs so explicit usage takes priority.
        autoPairs.push({ cmd: tl.cmd, args: [sub], uses: 0, label: `${tl.cmd} ${sub}` });
        added++;
      }
    }
  }

  // Output order: top-levels by frequency, then history-observed pairs by
  // frequency, then auto-detected subcommands. Limit applies to the whole.
  const combined = [...topLevel, ...pairs, ...autoPairs];
  return opts.limit ? combined.slice(0, opts.limit) : combined;
}

export async function precache(dora: Dora, cfg: Config, opts: PrecacheOptions): Promise<number> {
  try {
    return await precacheImpl(dora, cfg, opts);
  } finally {
    closeReadline();
  }
}

async function precacheDirect(
  dora: Dora,
  cfg: Config,
  opts: PrecacheOptions,
  variants: Variant[],
): Promise<number> {
  const [cmd, ...args] = opts.directArgs!;
  if (!cmd || !/^[A-Za-z0-9._+-]+$/.test(cmd)) {
    writeError(`コマンド名が不正: ${cmd ?? ""}`);
    return 64;
  }
  if (!(await isCommandAvailable(cmd))) {
    writeError(`コマンドが見つかりません: ${cmd}`);
    return 1;
  }

  writeLine(pc.cyan("precache (direct)"));
  writeDim(`  target: ${[cmd, ...args].join(" ")}`);
  writeLine();

  // uses=-1 → direct user target (differentiated from history and auto).
  const candidates: Candidate[] = [
    { cmd, args, uses: -1, label: [cmd, ...args].join(" ") },
  ];

  // Auto-detect subs only when the user gave a bare top-level cmd.
  const autoSubs = opts.autoSubs ?? 8;
  if (autoSubs > 0 && args.length === 0) {
    const subs = await enumerateSubcommands(cmd).catch(() => [] as string[]);
    for (const sub of subs.slice(0, autoSubs)) {
      candidates.push({ cmd, args: [sub], uses: 0, label: `${cmd} ${sub}` });
    }
  }
  const limited = opts.limit ? candidates.slice(0, opts.limit) : candidates;
  return runCandidates(dora, cfg, limited, variants, opts);
}

async function precacheImpl(dora: Dora, cfg: Config, opts: PrecacheOptions): Promise<number> {
  const variants: Variant[] = opts.variants ?? [{ mode: "summary", tone: "default" }];

  // Direct mode: user supplied the command(s) on the command line — no
  // history read, no permission prompt.
  if (opts.directArgs && opts.directArgs.length > 0) {
    return precacheDirect(dora, cfg, opts, variants);
  }

  const historyFile = opts.historyFile ?? defaultHistoryPath();

  writeLine(pc.cyan("precache"));
  writeDim(`  history file: ${historyFile}`);
  if (!existsSync(historyFile)) {
    writeError(`履歴ファイルが見つかりません: ${historyFile}`);
    return 1;
  }
  const st = statSync(historyFile);
  writeDim(`  size: ${(st.size / 1024).toFixed(1)} KB, modified: ${st.mtime.toISOString()}`);
  writeLine();

  // Ask permission before reading the history file (privacy).
  if (!opts.assumeYes) {
    const ok = await confirm(
      `シェル履歴を読み取ってもよいですか？ 個人情報を含む可能性があります [y/N] `,
    );
    if (!ok) {
      writeDim("中断しました（履歴は読み取っていません）");
      return 3;
    }
  } else {
    writeDim("(--yes 指定のため履歴読み取り確認をスキップ)");
  }

  const candidates = await discover(opts);
  return runCandidates(dora, cfg, candidates, variants, opts);
}

/** Shared "display + estimate + run" pipeline for both history-scan and
 *  direct-arg modes. */
async function runCandidates(
  dora: Dora,
  cfg: Config,
  candidates: Candidate[],
  variants: Variant[],
  opts: PrecacheOptions,
): Promise<number> {
  const historyCount = candidates.filter((c) => c.uses > 0).length;
  const autoCount = candidates.filter((c) => c.uses === 0).length;
  const directCount = candidates.filter((c) => c.uses < 0).length;
  const parts: string[] = [];
  if (directCount > 0) parts.push(`指定 ${directCount}`);
  if (historyCount > 0) parts.push(`履歴 ${historyCount}`);
  if (autoCount > 0) parts.push(`auto ${autoCount}`);
  writeLine();
  writeLine(
    `対象: ${pc.bold(String(candidates.length))} 件 ` +
      pc.dim(`(${parts.join(" + ")})`),
  );
  for (const c of candidates) {
    const tag = c.uses < 0 ? "(target)" : c.uses === 0 ? "(auto)" : `${c.uses}x`;
    writeDim(`  ${c.label.padEnd(24)}  ${tag}`);
  }

  if (candidates.length === 0) {
    writeLine();
    writeError("キャッシュ対象が 0 件");
    return 1;
  }

  // Fixed up-front estimate. We used to run the 1st item and then show
  // another prompt mid-flow, but that path caused zsh to SIGTTIN/SIGTTOU
  // the node process after the LLM call — every interactive read between
  // the 1st and 2nd item suspended the precache. Showing an a-priori
  // estimate here and failing fast (rather than prompting) keeps stdin
  // untouched once the LLM loop starts.
  const perItemSecs = variants.reduce((a, v) => a + (VARIANT_SECS[variantLabel(v)] ?? 15), 0);
  const totalOps = candidates.length * variants.length;
  const estMin = (candidates.length * perItemSecs) / 60;
  const threshold = opts.thresholdMinutes ?? 2;
  writeLine();
  writeLine(
    `variants: ${pc.bold(variants.map(variantLabel).join(", "))} ` +
      pc.dim(`(${variants.length} 種 × ${candidates.length} コマンド = ${totalOps} 件)`),
  );
  writeLine(
    `推定所要時間 ${pc.bold(estMin.toFixed(1))} 分 ` +
      pc.dim(`(1 コマンドあたり ~${perItemSecs}s、実測でズレる可能性あり)`),
  );

  if (opts.dryRun) {
    writeLine();
    writeDim("--dry-run: 実行せず終了");
    return 0;
  }

  if (estMin > threshold && !opts.assumeYes) {
    writeError(
      `閾値 ${threshold} 分を超えています。全件キャッシュするには ${pc.bold("-y")} を付けて再実行してください\n` +
        `  例: dora precache -y --limit 10`,
    );
    return 3;
  }

  writeLine();
  writeLine(pc.cyan("キャッシュ開始… (Ctrl-C で中断)"));

  let hits = 0;
  let misses = 0;
  let failures = 0;
  let opIndex = 0;
  for (const c of candidates) {
    for (const v of variants) {
      opIndex++;
      const idx = `[${opIndex}/${totalOps}]`;
      const variantTag = variants.length > 1 ? pc.dim(` ${variantLabel(v)}`) : "";
      try {
        const t0 = Date.now();
        let wasHit = false;
        const onDone = ({ cacheHit }: { cacheHit: boolean }) => (wasHit = cacheHit);
        if (v.mode === "summary") {
          await summary(dora, cfg, c.cmd, c.args, {
            stream: false,
            quiet: true,
            tone: v.tone,
            cache: { disabled: false, refresh: false },
            onComplete: onDone,
          });
        } else {
          await translate(dora, cfg, c.cmd, c.args, {
            stream: false,
            quiet: true,
            tone: v.tone,
            cache: { disabled: false, refresh: false },
            onComplete: onDone,
          });
        }
        const ms = Date.now() - t0;
        if (wasHit) hits++;
        else misses++;
        writeLine(
          `  ${pc.green("✓")} ${idx} ${c.label.padEnd(24)}${variantTag} ` +
            (wasHit ? pc.dim("(cached)") : `(${(ms / 1000).toFixed(1)}s)`),
        );
      } catch (e) {
        failures++;
        writeLine(
          `  ${pc.red("✗")} ${idx} ${c.label.padEnd(24)}${variantTag} ${pc.red((e as Error).message)}`,
        );
      }
    }
  }

  writeLine();
  writeLine(
    `完了: ${pc.green(`${misses} 件キャッシュ`)}` +
      (hits > 0 ? `, ${pc.dim(`${hits} 件は既にキャッシュ済み`)}` : "") +
      (failures > 0 ? `, ${pc.red(`${failures} 件失敗`)}` : ""),
  );
  return failures > 0 ? 1 : 0;
}
