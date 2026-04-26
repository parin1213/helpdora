import { resolvePowerShellCommand, runCmd } from "./command-runtime.js";

const TIMEOUT_MS = 2_500;

/**
 * True if `name` is an executable on PATH *or* a shell function/alias defined
 * in the user's interactive shell (e.g. zoxide's `z`). Used by mode detection
 * to decide whether the first token is a command or natural-language text.
 */
export async function isCommandAvailable(name: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;

  if (process.platform === "win32") {
    return (await resolvePowerShellCommand(name, TIMEOUT_MS)) !== null;
  }

  if (await isOnPath(name)) return true;
  return isDefinedInShell(name);
}

async function isOnPath(name: string): Promise<boolean> {
  const result = await runCmd("which", [name], TIMEOUT_MS);
  return result.code === 0 && result.out.trim().length > 0;
}

async function isDefinedInShell(name: string): Promise<boolean> {
  const shell = process.env.SHELL || "/bin/zsh";
  const result = await runCmd(shell, ["-ic", `type -- ${shellQuote(name)}`], TIMEOUT_MS);
  if (!result.out) return false;
  return /(function|alias|is\s+\/)/.test(result.out);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._+\-/=]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
