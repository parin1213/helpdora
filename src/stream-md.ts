import pc from "picocolors";
import { highlight } from "cli-highlight";
import { ThinkingSpinner } from "./render.js";

const DEFAULT_WIDTH = 80;
const MAX_BAR_WIDTH = 100;
const TABLE_CELL_PAD = 1;

function termWidth(): number {
  const w = process.stdout.columns;
  if (!w || w < 20) return DEFAULT_WIDTH;
  return Math.min(w, MAX_BAR_WIDTH);
}

function visualWidth(s: string): number {
  const stripped = s.replace(/\u001b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK-ish full-width ranges (hiragana, katakana, Kangxi, CJK unified, fullwidth forms, CJK symbols)
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa960 && cp <= 0xa97f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else if (cp >= 0x20) {
      w += 1;
    }
  }
  return w;
}

function padVisual(s: string, target: number): string {
  const pad = target - visualWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/**
 * Visual width that also strips markdown markers (`**bold**`, `` `code` ``,
 * `[text](url)`) so it matches what will actually appear on screen after
 * `inline()` replaces those markers with ANSI styling. Raw `visualWidth`
 * on pre-styled cell content double-counts the markers and causes column
 * separators to drift right of cells containing inline formatting.
 */
function renderedWidth(raw: string): number {
  const stripped = raw
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  return visualWidth(stripped);
}

/**
 * Line-buffered Markdown → ANSI renderer for streaming LLM output.
 * Buffers partial chunks until a newline, then styles the complete line
 * and writes it to stdout. Code fences and tables are buffered across
 * multiple lines so they can be rendered as aligned blocks.
 */
export class MarkdownStream {
  private buffer = "";
  private inCode = false;
  private codeLang = "";
  private tableRows: string[] = [];
  // Track consecutive blank lines so we can collapse 2+ blanks to 1 and
  // never emit a leading blank before any content has appeared.
  private blankStreak = 1;
  // Tables are buffered until all rows arrive so column widths can be
  // computed; show a spinner so the user sees progress during the wait.
  private tableSpinner = new ThinkingSpinner();
  private tableSpinnerActive = false;

  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

  write(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.renderLine(line);
    }
  }

  end(): void {
    if (this.buffer.length > 0) {
      this.renderLine(this.buffer);
      this.buffer = "";
    }
    this.flushTable();
    if (this.blankStreak === 0) this.out.write("\n");
  }

  private emit(line: string): void {
    this.out.write(line + "\n");
    this.blankStreak = 0;
  }

  private emitBlank(): void {
    if (this.blankStreak >= 1) return;
    this.out.write("\n");
    this.blankStreak = 1;
  }

  private renderLine(line: string): void {
    // code fence toggle — also flushes any pending table first
    const fence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (fence) {
      this.flushTable();
      const lang = fence[2] ?? "";
      const barWidth = termWidth();
      if (!this.inCode) {
        this.inCode = true;
        this.codeLang = lang;
        const label = lang ? ` ${lang} ` : "";
        const dashes = Math.max(2, barWidth - 2 - visualWidth(label));
        this.emit(pc.gray("┌─" + label) + pc.gray("─".repeat(dashes - 1) + "┐"));
      } else {
        this.inCode = false;
        this.codeLang = "";
        this.emit(pc.gray("└" + "─".repeat(barWidth - 2) + "┘"));
      }
      return;
    }

    if (this.inCode) {
      let content = line;
      if (this.codeLang) {
        try {
          content = highlight(line, { language: this.codeLang, ignoreIllegals: true });
        } catch {
          /* fall back to plain */
        }
      }
      this.emit(pc.gray("│ ") + content);
      return;
    }

    // table rows get buffered until we hit a non-pipe line
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (this.tableRows.length === 0 && !this.tableSpinnerActive) {
        this.tableSpinner.start("テーブル生成中");
        this.tableSpinnerActive = true;
      }
      this.tableRows.push(line);
      return;
    }
    // current line isn't a table row → flush any pending table before rendering this line
    this.flushTable();

    // blank line
    if (/^\s*$/.test(line)) {
      this.emitBlank();
      return;
    }

    // horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      this.emit(pc.gray("─".repeat(termWidth())));
      return;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = this.inline(h[2]!);
      const styled = level <= 1 ? pc.bold(pc.cyan(text)) : level === 2 ? pc.bold(pc.blue(text)) : pc.cyan(text);
      // Ensure a single blank line before headings, even if the previous
      // line was adjacent content.
      this.emitBlank();
      this.emit(styled);
      return;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const content = line.replace(/^\s*>\s?/, "");
      this.emit(pc.gray("│ ") + pc.dim(this.inline(content)));
      return;
    }

    // bullet list
    let m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (m) {
      this.emit(m[1] + pc.cyan("•") + " " + this.inline(m[2]!));
      return;
    }

    // numbered list
    m = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (m) {
      this.emit(m[1] + pc.cyan(m[2] + ".") + " " + this.inline(m[3]!));
      return;
    }

    // ordinary line
    this.emit(this.inline(line));
  }

  private inline(text: string): string {
    // process in a single pass so overlapping spans don't double-wrap
    return text
      .replace(/\*\*([^*\n]+)\*\*/g, (_, t: string) => pc.bold(t))
      .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, (_, pre: string, t: string) => pre + pc.italic(t))
      .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s.,;:!?)]|$)/g, (_, pre: string, t: string) => pre + pc.italic(t))
      .replace(/`([^`\n]+)`/g, (_, t: string) => pc.yellow(t))
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt: string, url: string) => pc.underline(txt) + pc.dim(` (${url})`));
  }

  private flushTable(): void {
    if (this.tableRows.length === 0) return;
    if (this.tableSpinnerActive) {
      this.tableSpinner.stop();
      this.tableSpinnerActive = false;
    }
    const rows = this.tableRows;
    this.tableRows = [];
    // A valid Markdown table needs at least a header + separator row
    if (rows.length >= 2 && /^\s*\|[\s:\-|]+\|\s*$/.test(rows[1]!)) {
      this.renderTable(rows);
    } else {
      for (const r of rows) this.emit(this.inline(r));
    }
  }

  private renderTable(rows: string[]): void {
    const parseCells = (line: string): string[] =>
      line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

    const header = parseCells(rows[0]!);
    const sep = parseCells(rows[1]!);
    const body = rows.slice(2).map(parseCells);
    const cols = header.length;
    const aligns: ("left" | "right" | "center")[] = sep.map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      return left && right ? "center" : right ? "right" : "left";
    });

    // Step 1: decide the outer frame up-front.
    // Overhead: leading │ + (2 padding + trailing │) per column
    const total = termWidth();
    const overhead = 1 + cols * 3;
    const available = Math.max(cols * 4, total - overhead);

    // Step 2: allocate column widths. Use rendered (post-markdown) width
    // so `**bold**` / `` `code` `` markers don't inflate the column.
    const natural: number[] = new Array(cols).fill(0);
    for (let i = 0; i < cols; i++) {
      let w = renderedWidth(header[i] ?? "");
      for (const r of body) w = Math.max(w, renderedWidth(r[i] ?? ""));
      natural[i] = Math.max(1, w);
    }
    // Shrink-to-fit: keep naturally short columns intact, take space
    // off the widest columns repeatedly until the total fits.
    const widths: number[] = [...natural];
    const minWidth = 4;
    let sum = widths.reduce((a, b) => a + b, 0);
    while (sum > available) {
      let idx = 0;
      for (let i = 1; i < cols; i++) if (widths[i]! > widths[idx]!) idx = i;
      if (widths[idx]! <= minWidth) break;
      widths[idx] = widths[idx]! - 1;
      sum--;
    }

    // Step 3: wrap cells. Tokenize so inline spans (`code`, **bold**)
    // are atomic — they never get split across wrap boundaries. Words
    // break at whitespace; CJK characters wrap per-character.
    const ATOMIC = /`[^`\n]+`|\*\*[^*\n]+\*\*/g;
    const tokenize = (raw: string): string[] => {
      const toks: string[] = [];
      const emitPlain = (s: string): void => {
        let buf = "";
        for (const ch of s) {
          if (visualWidth(ch) === 2 || /\s/.test(ch)) {
            if (buf) { toks.push(buf); buf = ""; }
            toks.push(ch);
          } else {
            buf += ch;
          }
        }
        if (buf) toks.push(buf);
      };
      let last = 0;
      for (const m of raw.matchAll(ATOMIC)) {
        if (m.index! > last) emitPlain(raw.slice(last, m.index!));
        toks.push(m[0]);
        last = m.index! + m[0].length;
      }
      if (last < raw.length) emitPlain(raw.slice(last));
      return toks;
    };

    const wrapRaw = (raw: string, width: number): string[] => {
      if (renderedWidth(raw) <= width) return [raw];
      const lines: string[] = [];
      let cur = "";
      let curW = 0;
      const flushLine = (): void => {
        lines.push(cur.replace(/\s+$/u, ""));
        cur = "";
        curW = 0;
      };
      for (const tok of tokenize(raw)) {
        // Use rendered width for atomic tokens so markdown markers don't
        // inflate budgets (e.g. `` `exec` `` counts as 4, not 6).
        const tw = renderedWidth(tok);
        const isSpace = /^\s+$/.test(tok);
        if (curW + tw > width && curW > 0) {
          flushLine();
          if (isSpace) continue; // drop leading whitespace on new line
        }
        if (tw > width) {
          if (curW > 0) flushLine();
          for (const ch of tok) {
            const cw = visualWidth(ch);
            if (curW + cw > width) flushLine();
            cur += ch;
            curW += cw;
          }
          continue;
        }
        cur += tok;
        curW += tw;
      }
      if (cur) flushLine();
      return lines;
    };

    const align = (styled: string, rawWidth: number, w: number, how: "left" | "right" | "center"): string => {
      const pad = w - rawWidth;
      if (pad <= 0) return styled;
      if (how === "right") return " ".repeat(pad) + styled;
      if (how === "center") {
        const l = Math.floor(pad / 2);
        return " ".repeat(l) + styled + " ".repeat(pad - l);
      }
      return styled + " ".repeat(pad);
    };

    const bar = (left: string, mid: string, right: string): string =>
      left + widths.map((w) => "─".repeat(w + 2 * TABLE_CELL_PAD)).join(mid) + right;

    const renderRow = (cells: string[], bold: boolean): void => {
      const wrapped = cells.map((c, i) => wrapRaw(c ?? "", widths[i] ?? 0));
      const maxLines = Math.max(...wrapped.map((w) => w.length));
      for (let li = 0; li < maxLines; li++) {
        const parts = wrapped.map((lines, i) => {
          const rawPiece = lines[li] ?? "";
          const stylePiece = rawPiece ? this.inline(rawPiece) : "";
          const finalStyle = bold && li === 0 && stylePiece ? pc.bold(stylePiece) : stylePiece;
          // Align on rendered width, NOT raw — markdown markers are
          // consumed by `inline()` so the on-screen width is shorter.
          const aligned = align(finalStyle, renderedWidth(rawPiece), widths[i] ?? 0, aligns[i] ?? "left");
          return " " + aligned + " ";
        });
        this.emit(pc.gray("│") + parts.join(pc.gray("│")) + pc.gray("│"));
      }
    };

    this.emit(pc.gray(bar("┌", "┬", "┐")));
    renderRow(header, true);
    this.emit(pc.gray(bar("├", "┼", "┤")));
    for (let i = 0; i < body.length; i++) {
      renderRow(body[i]!, false);
      if (i < body.length - 1) this.emit(pc.gray(bar("├", "┼", "┤")));
    }
    this.emit(pc.gray(bar("└", "┴", "┘")));
  }
}
