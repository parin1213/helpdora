// Subprocess-based providers for the "premium" models — `claude -p` and
// `codex exec`. Works by piping a flattened prompt to the CLI on stdin and
// reading the response. No streaming (v1): we await the whole process then
// emit the response in one chunk. A ThinkingSpinner is shown in the
// meantime so the user has feedback.
//
// These providers only support plain-text streaming, not the zod
// `structured()` flow used by INTENT/LOOKUP. Callers should reject
// non-"lm-studio" providers for those modes.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export type CliProvider = "claude" | "codex";

export function flattenMessages(messages: ChatCompletionMessageParam[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m.role === "system") {
      parts.push(`[System instructions]\n${content}`);
    } else if (m.role === "user") {
      parts.push(`[User request]\n${content}`);
    } else if (m.role === "assistant") {
      parts.push(`[Assistant earlier reply]\n${content}`);
    } else {
      parts.push(`[${m.role}]\n${content}`);
    }
  }
  return parts.join("\n\n");
}

export async function runProvider(
  provider: CliProvider,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  if (provider === "claude") return runClaude(prompt, timeoutMs);
  return runCodex(prompt, timeoutMs);
}

/** `claude -p` with `--output-format text`. Reads prompt from stdin, writes
 *  response to stdout. */
async function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  const child = spawn("claude", ["-p", "--output-format", "text"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  child.stdin.write(prompt);
  child.stdin.end();

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => outChunks.push(b));
  child.stderr.on("data", (b: Buffer) => errChunks.push(b));

  const killer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  clearTimeout(killer);

  const out = Buffer.concat(outChunks).toString("utf8");
  if (code !== 0) {
    const err = Buffer.concat(errChunks).toString("utf8").slice(0, 500);
    throw new Error(`claude exited ${code}: ${err.trim() || "(no stderr)"}`);
  }
  return out.trim();
}

/** `codex exec --skip-git-repo-check -o <tmpfile> -` — reads prompt from
 *  stdin, writes the final assistant message to a temp file, which we read
 *  back. stdout gets cluttered with agent traces otherwise. */
async function runCodex(prompt: string, timeoutMs: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dora-codex-"));
  const outFile = join(dir, "last.txt");
  try {
    const child = spawn(
      "codex",
      ["exec", "--skip-git-repo-check", "--output-last-message", outFile, "-"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      },
    );
    child.stdin.write(prompt);
    child.stdin.end();

    const errChunks: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => errChunks.push(b));
    // stdout is noisy agent output; we ignore it here.
    child.stdout.on("data", () => {});

    const killer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const code: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    clearTimeout(killer);

    if (code !== 0) {
      const err = Buffer.concat(errChunks).toString("utf8").slice(0, 500);
      throw new Error(`codex exited ${code}: ${err.trim() || "(no stderr)"}`);
    }
    return readFileSync(outFile, "utf8").trim();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
