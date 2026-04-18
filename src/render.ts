import pc from "picocolors";
import { highlight } from "cli-highlight";

export function writeHeader(title: string): void {
  process.stdout.write(pc.bold(pc.cyan(title)) + "\n");
}

export function writeLine(s: string = ""): void {
  process.stdout.write(s + "\n");
}

export function writeChunk(s: string): void {
  process.stdout.write(s);
}

export function writeCommandBox(cmd: string): void {
  const body = highlight(cmd, { language: "bash", ignoreIllegals: true });
  const width = stripAnsi(cmd).length + 4;
  const bar = pc.gray("─".repeat(width));
  process.stdout.write(bar + "\n");
  process.stdout.write("  " + body + "  \n");
  process.stdout.write(bar + "\n");
}

export function writeCaveat(s: string): void {
  process.stdout.write(pc.yellow("⚠ ") + s + "\n");
}

export function writeDim(s: string): void {
  process.stdout.write(pc.dim(s) + "\n");
}

export function writeError(s: string): void {
  process.stderr.write(pc.red("✗ ") + s + "\n");
}

export function writeDebug(s: string): void {
  process.stderr.write(pc.dim("[debug] ") + s + "\n");
}

export function writeReasoningChunk(s: string): void {
  process.stderr.write(pc.dim(s));
}

export function writeReasoningEnd(): void {
  if (process.stderr.isTTY) process.stderr.write("\n");
}

export class ThinkingSpinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  start(label = "思考中"): void {
    if (this.active || !process.stderr.isTTY) return;
    this.active = true;
    this.timer = setInterval(() => {
      const f = this.frames[this.frame % this.frames.length];
      process.stderr.write(`\r${pc.dim(f + " " + label + "...")}`);
      this.frame++;
    }, 100);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}
