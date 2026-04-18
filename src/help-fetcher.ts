import { spawn } from "node:child_process";

export class CommandNotFoundError extends Error {
  constructor(public readonly cmd: string) {
    super(`command not found: ${cmd}`);
    this.name = "CommandNotFoundError";
  }
}

export class HelpNotFoundError extends Error {
  constructor(public readonly cmd: string) {
    super(`help not available: ${cmd}`);
    this.name = "HelpNotFoundError";
  }
}

export interface HelpResult {
  source: "help" | "short-help" | "man";
  text: string;
  cmd: string;
  args: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BYTES = 200 * 1024;

export interface FetchOptions {
  timeoutMs?: number;
  source?: "auto" | "help" | "man";
  maxBytes?: number;
  /** internal: limit recursion when unwrapping shell-function wrappers */
  maxHops?: number;
}

export async function fetchHelp(
  cmd: string,
  args: readonly string[] = [],
  opts: FetchOptions = {},
): Promise<HelpResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, source = "auto", maxBytes = MAX_BYTES } = opts;

  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) {
    throw new CommandNotFoundError(cmd);
  }

  const onPath = await isOnPath(cmd);
  // When the name isn't on PATH, it may still be a shell function or alias
  // (e.g. zoxide's `z`). Defer the CommandNotFoundError to after we try a
  // shell-aware fallback below.
  const viaShell = !onPath;
  if (viaShell) {
    const defined = await isDefinedInShell(cmd, timeoutMs);
    if (!defined) throw new CommandNotFoundError(cmd);
  }

  // Shell-function wrappers (e.g. `z` → zoxide) often swallow `--help` as
  // a query arg. If nothing yields help, we'll try to extract the real
  // underlying binary from the function body and retry once.
  const maxHops = opts.maxHops ?? 1;

  interface Attempt {
    source: HelpResult["source"];
    run: () => Promise<RunResult>;
    accept: (r: RunResult) => boolean;
  }
  const attempts: Attempt[] = [];

  const runHelp = (flag: "--help" | "-h"): Promise<RunResult> =>
    viaShell
      ? runShell(`${cmd} ${args.map(shellQuote).join(" ")} ${flag}`, timeoutMs)
      : runCmd(cmd, [...args, flag], timeoutMs);

  if (source === "auto" || source === "help") {
    attempts.push({
      source: "help",
      run: () => runHelp("--help"),
      // many BSD tools print usage to stderr with exit != 0
      accept: (r) => looksLikeHelp(r.out),
    });
  }
  if (source === "auto" || source === "man") {
    attempts.push({
      source: "man",
      run: () => runCmd("man", [cmd], timeoutMs, { MANPAGER: "cat", MANWIDTH: "100" }),
      accept: (r) => r.code === 0 && r.out.trim().length > 50,
    });
  }
  if (source === "auto" || source === "help") {
    attempts.push({
      source: "short-help",
      run: () => runHelp("-h"),
      accept: (r) => looksLikeHelp(r.out),
    });
  }

  for (const attempt of attempts) {
    const res = await attempt.run().catch((): RunResult => ({ code: 1, out: "" }));
    if (attempt.accept(res)) {
      return {
        source: attempt.source,
        text: truncate(res.out, maxBytes),
        cmd,
        args,
      };
    }
  }

  // Last-ditch effort for shell-function wrappers: inspect the function
  // body, find the real underlying binary, and retry once with it.
  if (viaShell && maxHops > 0) {
    const binary = await extractUnderlyingBinary(cmd, timeoutMs);
    if (binary && binary !== cmd) {
      return fetchHelp(binary, args, { ...opts, maxHops: 0 });
    }
  }

  throw new HelpNotFoundError(cmd);
}

const SHELL_WORDS = new Set([
  "function", "return", "local", "builtin", "command", "typeset", "declare",
  "echo", "printf", "test", "then", "else", "elif", "fi", "for", "while",
  "done", "case", "esac", "exit", "eval", "result", "args", "arg", "query",
  "true", "false", "shift", "unset", "read", "pwd", "cd", "source",
]);

async function extractUnderlyingBinary(cmd: string, timeoutMs: number): Promise<string | null> {
  // Pull the function body plus any obvious `__cmd_*` helpers in one shell
  // invocation (cheaper than multiple rc reloads). Exit code is ignored
  // because `zsh -ic` may exit non-zero on rc warnings.
  const probe = `typeset -f ${shellQuote(cmd)} __${cmd}_z __zoxide_${cmd} _${cmd}_hook 2>/dev/null; true`;
  const r = await runShell(probe, Math.min(timeoutMs, 4_000));
  if (!r.out) return null;

  const candidates: string[] = [];
  for (const m of r.out.matchAll(/\b([a-z][a-z0-9_-]{2,})\b/g)) {
    const w = m[1]!;
    if (w === cmd || SHELL_WORDS.has(w) || w.startsWith("__")) continue;
    if (!candidates.includes(w)) candidates.push(w);
  }
  for (const c of candidates) {
    if (await isOnPath(c)) return c;
  }
  return null;
}

interface RunResult {
  code: number;
  out: string;
}

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, LANG: "C", LC_ALL: "C", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const onData = (b: Buffer) => {
      totalBytes += b.length;
      if (totalBytes <= MAX_BYTES * 2) chunks.push(b);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const killer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", () => {
      clearTimeout(killer);
      resolve({ code: 1, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, out: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function isOnPath(cmd: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) return false;
  const r = await runCmd("which", [cmd], 2_000);
  return r.code === 0 && r.out.trim().length > 0;
}

/**
 * Run `$SHELL -ic` so the user's rc file is sourced, revealing shell
 * functions / aliases (e.g. zoxide's `z`). We only reach here after the
 * `isOnPath` check failed, so there's a real chance the name is a shell
 * function.
 */
async function runShell(command: string, timeoutMs: number): Promise<RunResult> {
  const shell = process.env.SHELL || "/bin/zsh";
  return runCmd(shell, ["-ic", command], timeoutMs);
}

async function isDefinedInShell(cmd: string, timeoutMs: number): Promise<boolean> {
  // Don't gate on exit code — `zsh -ic` often exits non-zero on rc warnings
  // ("can't change option: zle" etc.) while still producing valid output.
  const r = await runShell(`type ${shellQuote(cmd)}`, Math.min(timeoutMs, 4_000));
  if (!r.out) return false;
  // `type` prints things like "z is a shell function" / "z is an alias for ..."
  return /(function|alias|is\s+\/)/.test(r.out);
}

function shellQuote(s: string): string {
  // only permit simple tokens; never shell-interpret
  if (!/^[A-Za-z0-9._+\-/=]+$/.test(s)) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

function looksLikeHelp(out: string): boolean {
  if (out.trim().length < 30) return false;
  const first2KB = out.slice(0, 2048).toLowerCase();
  // Must contain at least one help marker
  const hasMarker =
    first2KB.includes("usage:") ||
    first2KB.includes("usage ") ||
    first2KB.includes("synopsis") ||
    first2KB.includes("options:") ||
    first2KB.includes("commands:") ||
    /^\s*--?[a-z][\w-]*[,\s]/m.test(out.slice(0, 2048));
  return hasMarker;
}

function truncate(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  return buf.subarray(0, max).toString("utf8") + "\n...[truncated]";
}
