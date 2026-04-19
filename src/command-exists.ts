import { spawn } from "node:child_process";

const TIMEOUT_MS = 2_500;

/**
 * True if `name` is an executable on PATH *or* a shell function/alias defined
 * in the user's interactive shell (e.g. zoxide's `z`). Used by mode detection
 * to decide whether the first token is a command or natural-language text.
 */
export async function isCommandAvailable(name: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  if (await isOnPath(name)) return true;
  return isDefinedInShell(name);
}

async function isOnPath(name: string): Promise<boolean> {
  const r = await runCmd("which", [name], TIMEOUT_MS);
  return r.code === 0 && r.out.trim().length > 0;
}

async function isDefinedInShell(name: string): Promise<boolean> {
  const shell = process.env.SHELL || "/bin/zsh";
  const r = await runCmd(shell, ["-ic", `type -- ${shellQuote(name)}`], TIMEOUT_MS);
  if (!r.out) return false;
  return /(function|alias|is\s+\/)/.test(r.out);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._+\-/=]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

interface RunResult {
  code: number;
  out: string;
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
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
