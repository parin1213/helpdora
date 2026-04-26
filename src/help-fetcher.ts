import {
  powerShellQuote,
  resolvePowerShellCommand,
  runCmd,
  runPowerShell,
  type PowerShellCommandInfo,
  type RunResult,
} from "./command-runtime.js";

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

export type HelpResult = {
  source: "help" | "short-help" | "man";
  text: string;
  cmd: string;
  args: readonly string[];
};

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BYTES = 200 * 1024;

export type FetchOptions = {
  timeoutMs?: number;
  source?: "auto" | "help" | "man";
  maxBytes?: number;
  /** internal: limit recursion when unwrapping shell-function wrappers */
  maxHops?: number;
};

export async function fetchHelp(
  cmd: string,
  args: readonly string[] = [],
  opts: FetchOptions = {},
): Promise<HelpResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, source = "auto", maxBytes = MAX_BYTES } = opts;

  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) {
    throw new CommandNotFoundError(cmd);
  }

  if (process.platform === "win32") {
    return fetchHelpWindows(cmd, args, { timeoutMs, source, maxBytes });
  }

  const onPath = await isOnPath(cmd);
  const viaShell = !onPath;
  if (viaShell) {
    const defined = await isDefinedInShell(cmd, timeoutMs);
    if (!defined) throw new CommandNotFoundError(cmd);
  }

  const maxHops = opts.maxHops ?? 1;

  type Attempt = {
    source: HelpResult["source"];
    run: () => Promise<RunResult>;
    accept: (result: RunResult) => boolean;
  };

  const attempts: Attempt[] = [];
  const runHelp = (flag: "--help" | "-h"): Promise<RunResult> =>
    viaShell
      ? runShell(`${cmd} ${args.map(shellQuote).join(" ")} ${flag}`, timeoutMs)
      : runCmd(cmd, [...args, flag], timeoutMs);

  if (source === "auto" || source === "help") {
    attempts.push({
      source: "help",
      run: () => runHelp("--help"),
      accept: (result) => looksLikeHelp(result.out),
    });
  }
  if (source === "auto" || source === "man") {
    attempts.push({
      source: "man",
      run: () => runCmd("man", [cmd], timeoutMs, { MANPAGER: "cat", MANWIDTH: "100" }),
      accept: (result) => result.code === 0 && result.out.trim().length > 50,
    });
  }
  if (source === "auto" || source === "help") {
    attempts.push({
      source: "short-help",
      run: () => runHelp("-h"),
      accept: (result) => looksLikeHelp(result.out),
    });
  }

  for (const attempt of attempts) {
    const result = await attempt.run().catch((): RunResult => ({ code: 1, out: "" }));
    if (attempt.accept(result)) {
      return {
        source: attempt.source,
        text: truncate(result.out, maxBytes),
        cmd,
        args,
      };
    }
  }

  if (viaShell && maxHops > 0) {
    const binary = await extractUnderlyingBinary(cmd, timeoutMs);
    if (binary && binary !== cmd) {
      return fetchHelp(binary, args, { ...opts, maxHops: 0 });
    }
  }

  throw new HelpNotFoundError(cmd);
}

async function fetchHelpWindows(
  cmd: string,
  args: readonly string[],
  opts: Required<Pick<FetchOptions, "timeoutMs" | "source" | "maxBytes">>,
): Promise<HelpResult> {
  const resolved = await resolvePowerShellCommand(cmd, opts.timeoutMs);
  if (!resolved) throw new CommandNotFoundError(cmd);

  const helpTarget = resolvePowerShellHelpTarget(resolved);
  const attempts: Array<{
    source: HelpResult["source"];
    run: () => Promise<RunResult>;
    accept: (result: RunResult) => boolean;
  }> = [];

  if (opts.source === "auto" || opts.source === "man") {
    attempts.push({
      source: "man",
      run: () => runPowerShellHelp(helpTarget, opts.timeoutMs),
      accept: (result) => looksLikePowerShellHelp(result.out),
    });
  }

  if (opts.source === "auto" || opts.source === "help") {
    attempts.push({
      source: "help",
      run: () => runCmd(cmd, [...args, "--help"], opts.timeoutMs),
      accept: (result) => looksLikeHelp(result.out),
    });
    attempts.push({
      source: "short-help",
      run: () => runCmd(cmd, [...args, "-h"], opts.timeoutMs),
      accept: (result) => looksLikeHelp(result.out),
    });
  }

  for (const attempt of attempts) {
    const result = await attempt.run().catch((): RunResult => ({ code: 1, out: "" }));
    if (attempt.accept(result)) {
      return {
        source: attempt.source,
        text: truncate(result.out, opts.maxBytes),
        cmd,
        args,
      };
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
  const probe = `typeset -f ${shellQuote(cmd)} __${cmd}_z __zoxide_${cmd} _${cmd}_hook 2>/dev/null; true`;
  const result = await runShell(probe, Math.min(timeoutMs, 4_000));
  if (!result.out) return null;

  const candidates: string[] = [];
  for (const match of result.out.matchAll(/\b([a-z][a-z0-9_-]{2,})\b/g)) {
    const word = match[1]!;
    if (word === cmd || SHELL_WORDS.has(word) || word.startsWith("__")) continue;
    if (!candidates.includes(word)) candidates.push(word);
  }
  for (const candidate of candidates) {
    if (await isOnPath(candidate)) return candidate;
  }
  return null;
}

async function runPowerShellHelp(target: string, timeoutMs: number): Promise<RunResult> {
  const script = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `Get-Help ${powerShellQuote(target)} -Full | Out-String -Width 100`,
  ].join("; ");
  return runPowerShell(script, timeoutMs);
}

function resolvePowerShellHelpTarget(command: PowerShellCommandInfo): string {
  if (command.commandType === "Alias" && command.definition) {
    return command.definition;
  }
  return command.name;
}

async function isOnPath(cmd: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) return false;
  const result = await runCmd("which", [cmd], 2_000);
  return result.code === 0 && result.out.trim().length > 0;
}

async function runShell(command: string, timeoutMs: number): Promise<RunResult> {
  const shell = process.env.SHELL || "/bin/zsh";
  return runCmd(shell, ["-ic", command], timeoutMs);
}

async function isDefinedInShell(cmd: string, timeoutMs: number): Promise<boolean> {
  const result = await runShell(`type ${shellQuote(cmd)}`, Math.min(timeoutMs, 4_000));
  if (!result.out) return false;
  return /(function|alias|is\s+\/)/.test(result.out);
}

function shellQuote(value: string): string {
  if (!/^[A-Za-z0-9._+\-/=]+$/.test(value)) {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
  return value;
}

function looksLikeHelp(out: string): boolean {
  if (out.trim().length < 30) return false;
  const first2KB = out.slice(0, 2048).toLowerCase();
  const hasMarker =
    first2KB.includes("usage:") ||
    first2KB.includes("usage ") ||
    first2KB.includes("synopsis") ||
    first2KB.includes("options:") ||
    first2KB.includes("commands:") ||
    /^\s*--?[a-z][\w-]*[,\s]/m.test(out.slice(0, 2048));
  return hasMarker;
}

function looksLikePowerShellHelp(out: string): boolean {
  if (out.trim().length < 30) return false;

  const first4KB = out.slice(0, 4096).toLowerCase();
  const first4KBOriginal = out.slice(0, 4096);
  return (
    (first4KB.includes("name") && first4KB.includes("syntax")) ||
    (first4KB.includes("syntax") && first4KB.includes("description")) ||
    first4KB.includes("aliases") ||
    (first4KBOriginal.includes("名前") && first4KBOriginal.includes("構文")) ||
    first4KBOriginal.includes("パラメーター") ||
    first4KBOriginal.includes("エイリアス")
  );
}

function truncate(value: string, max: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= max) return value;
  return buffer.subarray(0, max).toString("utf8") + "\n...[truncated]";
}
