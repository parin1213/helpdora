// Precache reconnaissance: scan shell history and list candidate commands
// (and subcommand pairs) that would be worth caching. READ-ONLY — does not
// run the LLM. Used as input for deciding what `dora precache` should
// actually cache.
//
// Heuristics:
//   - first token = command, must be a bare identifier ([A-Za-z0-9._+-]+)
//   - skip builtins/noise: cd, echo, export, alias, source, true, false, :, .,
//     pwd, exit, clear, history, which, type, set, unset
//   - skip `dora` itself
//   - second token is "subcommand-shaped" iff: ASCII identifier, no leading
//     `-` or `/` or `=`, length 2..20, doesn't look like a path or URL
//   - (cmd) frequency reported for top uses
//   - (cmd, sub) pairs reported when sub appears ≥ 2 times AND the first
//     token has 3+ distinct subs observed (so `ls` doesn't spawn fake subs)
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isCommandAvailable } from "../src/command-exists.js";

const SKIP = new Set([
  "cd", "echo", "export", "alias", "unalias", "source", "set", "unset",
  "true", "false", ":", ".", "pwd", "exit", "clear", "history", "type",
  "which", "command", "eval", "exec", "read", "printf", "time", "builtin",
  "function", "return", "local", "declare", "typeset", "readonly", "hash",
  "dora",
]);

function parseZshHistory(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  // zsh extended format: ": <ts>:<dur>;<cmd>"; fallback to plain lines
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^:\s*\d+:\d+;(.*)$/);
    if (m) out.push(m[1]!);
    else if (line.trim() && !line.startsWith("#")) out.push(line);
  }
  return out;
}

function firstTokens(cmdline: string): string[] {
  // Strip sudo / env=val prefixes and pipe chains — take only the first
  // command in the line, and a couple of its leading args.
  const piece = cmdline.split(/[|;&]|\s&&\s|\s\|\|\s/)[0]!.trim();
  const tokens = piece.split(/\s+/).filter(Boolean);
  // Skip leading env-vars and sudo
  let i = 0;
  while (i < tokens.length && (tokens[i] === "sudo" || /^[A-Z][A-Z0-9_]*=/.test(tokens[i]!))) i++;
  return tokens.slice(i, i + 4);
}

function isSubShaped(tok: string): boolean {
  if (!tok) return false;
  if (tok.startsWith("-") || tok.startsWith("/") || tok.includes("=")) return false;
  if (tok.includes(":")) return false;
  if (!/^[a-z][a-zA-Z0-9_.-]{1,24}$/.test(tok)) return false;
  return true;
}

function isCmdShaped(tok: string): boolean {
  return /^[A-Za-z0-9._+-]{1,30}$/.test(tok);
}

async function main(): Promise<void> {
  const histPath = process.env.HISTFILE || join(homedir(), ".zsh_history");
  if (!existsSync(histPath)) {
    console.error(`history file not found: ${histPath}`);
    process.exit(1);
  }
  const lines = parseZshHistory(histPath);
  console.error(`parsed ${lines.length} history lines from ${histPath}`);

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

  // Only keep commands that are actually installed on this machine.
  const topCmds = [...cmdCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);
  const availability = await Promise.all(topCmds.map(async ([c]) => [c, await isCommandAvailable(c)] as const));
  const available = new Map(availability);

  console.log("# Top commands (installed only)");
  console.log(`| rank | command | uses | subs observed |`);
  console.log(`|-----:|---------|-----:|---------------|`);
  let rank = 0;
  for (const [cmd, uses] of topCmds) {
    if (!available.get(cmd)) continue;
    rank++;
    if (rank > 25) break;
    const subs = subCount.get(cmd);
    const subCountDistinct = subs ? subs.size : 0;
    console.log(`| ${rank} | ${cmd} | ${uses} | ${subCountDistinct} |`);
  }

  console.log("");
  console.log("# Subcommand pairs worth caching");
  console.log(`(cmd with ≥ 3 distinct subs, showing top pairs with ≥ 2 uses)`);
  console.log("");
  console.log(`| command | subcommand | uses |`);
  console.log(`|---------|------------|-----:|`);

  const pairs: [string, string, number][] = [];
  for (const [cmd, subs] of subCount.entries()) {
    if (!available.get(cmd)) continue;
    if (subs.size < 3) continue; // command doesn't look subcommand-shaped
    for (const [sub, n] of subs.entries()) {
      if (n >= 2) pairs.push([cmd, sub, n]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);
  for (const [cmd, sub, n] of pairs.slice(0, 30)) {
    console.log(`| ${cmd} | ${sub} | ${n} |`);
  }

  console.log("");
  console.log(`# Summary`);
  console.log(`- distinct top-level cmds seen: ${cmdCount.size}`);
  console.log(`- installed top-level cmds in top-25: ${topCmds.filter(([c]) => available.get(c)).slice(0, 25).length}`);
  console.log(`- subcommand pairs (≥2 uses, ≥3 distinct subs): ${pairs.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
