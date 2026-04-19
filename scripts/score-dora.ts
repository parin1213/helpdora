// 6-axis Doraemon-tone scorer. Reads stdin (or argv[2] as a file path) and
// prints a 0..100 score plus a per-axis breakdown. Pass --json for machine-
// readable output (used by scripts/improve-tone.ts).
//
// Axes (weights sum to 100):
//   語尾 (20)  — endings; prefer warm/plain, penalize theatrical
//   語彙 (15)  — vocabulary; ひみつ道具 good, 魔法の道具/emoji bad
//   構文 (20)  — rhythm; short sentences, no long チェーン
//   姿勢 (15)  — stance; guide-form good, horizontal 呼びかけ bad
//   順番 (15)  — empathy framing early in response
//   抑制 (15)  — catchphrase restraint; no ornamental やれやれ etc
import { readFileSync } from "node:fs";

export interface AxisScore {
  name: string;
  weight: number;
  score: number; // 0..1
  notes: string[];
}

export interface ScoreReport {
  total: number; // 0..100
  axes: AxisScore[];
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Remove code fences / inline code / ANSI / headings so we score prose only. */
function strip(t: string): string {
  let s = stripAnsi(t);
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`[^`]+`/g, "");
  s = s.replace(/^#+\s.*$/gm, "");
  return s;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/** Split into prose sentences for syntax measurement. Bullet list items
 *  often lack 。 at end (e.g. `- z — 素早く飛ぶんだ`), so newlines are
 *  treated as sentence boundaries too. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？])\s*|\n+/)
    .map((s) => s.replace(/^[-•*\s]+/, "").trim())
    .filter((s) => s.length >= 8);
}

/** Logistic squash into 0..1 given ideal count band [lo, hi]. */
function band(count: number, lo: number, hi: number): number {
  if (count <= 0) return 0;
  if (count >= lo && count <= hi) return 1;
  if (count < lo) return count / lo;
  // too many — gently decay
  return Math.max(0, 1 - (count - hi) / (hi + 1));
}

function scoreEndings(t: string): AxisScore {
  const notes: string[] = [];
  const warm =
    countMatches(t, /だよ[。！？\n]/g) +
    countMatches(t, /なんだ[。！？\n]/g) +
    countMatches(t, /できるよ[。！？\n]/g) +
    countMatches(t, /してごらん[。！？\n]/g) +
    countMatches(t, /するといいよ[。！？\n]/g) +
    countMatches(t, /すればいいんだ[。！？\n]/g) +
    // Plain 〜んだ (飛ぶんだ, 動かないんだ) — common Doraemon ending, very Doraemon
    countMatches(t, /(?<!な)んだ[。！？\n]/g) +
    // Action verb + よ (行くよ, するよ, 見つかるよ) — exclude だよ (counted above) and past-tense
    countMatches(t, /[うくすつぬむゆるぐずぶ]よ[。！？\n]/g);
  const theatrical =
    countMatches(t, /のさ[。！？\n]/g) +
    countMatches(t, /のだ[。！？\n]/g) +
    countMatches(t, /だぜ[。！？\n]/g) +
    countMatches(t, /なのさ[。！？\n]/g);
  const polite =
    countMatches(t, /(です|ます)[。、\n]/g) + countMatches(t, /である[。\n]/g);

  const sents = Math.max(1, sentences(t).length);
  const warmRatio = warm / sents;
  const theatricalRatio = theatrical / sents;

  let s = Math.min(1, warmRatio * 1.8); // saturate at ~55% warm endings
  s -= Math.min(0.6, theatricalRatio * 2.5); // big penalty for ornamentals
  s -= Math.min(0.5, (polite / sents) * 2);
  s = Math.max(0, Math.min(1, s));

  if (warm > 0) notes.push(`warm endings: ${warm}`);
  if (theatrical > 0) notes.push(`theatrical endings (bad): ${theatrical}`);
  if (polite > 0) notes.push(`polite/stiff endings (bad): ${polite}`);
  return { name: "語尾", weight: 20, score: s, notes };
}

function scoreVocabulary(t: string): AxisScore {
  const notes: string[] = [];
  const hibitu = countMatches(t, /ひみつ道具/g);
  const magic = countMatches(t, /(魔法の道具|魔法のツール|便利グッズ)/g);
  // Exclude rendering markers that our own CLI prepends (⚠ caveats,
  // ✓ / ✗ status glyphs). Only LLM-produced pictograph emoji are penalised.
  const emoji = countMatches(
    t,
    /(?!⚠|✓|✗|✕|❯|▸|•|█|─)[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}]/gu,
  );
  // Note: katakana density is intentionally NOT scored — CLI descriptions
  // naturally contain unavoidable technical nouns (オプション, ディレクトリ).

  let s = 0.5; // neutral baseline
  // ひみつ道具: 1 回なら肯定、2 回以上はコスプレ的に使われているので減点
  if (hibitu === 1) s += 0.2;
  else if (hibitu >= 2) s -= Math.min(0.4, (hibitu - 1) * 0.15);
  s -= Math.min(0.8, magic * 0.5);
  s -= Math.min(0.5, emoji * 0.25);
  s = Math.max(0, Math.min(1, s));

  if (hibitu === 1) notes.push(`ひみつ道具: 1 (ok)`);
  else if (hibitu >= 2) notes.push(`ひみつ道具: ${hibitu} (overused)`);
  if (magic > 0) notes.push(`魔法の道具/類 (bad): ${magic}`);
  if (emoji > 0) notes.push(`emoji (bad): ${emoji}`);
  return { name: "語彙", weight: 15, score: s, notes };
}

function scoreSyntax(t: string): AxisScore {
  const notes: string[] = [];
  const sents = sentences(t);
  if (sents.length === 0) return { name: "構文", weight: 20, score: 0, notes: ["no sentences"] };
  const avgLen = sents.reduce((a, x) => a + x.length, 0) / sents.length;
  const longRatio = sents.filter((x) => x.length > 70).length / sents.length;
  const chains = sents.filter((x) => (x.match(/、/g)?.length ?? 0) >= 3).length;
  const chainRatio = chains / sents.length;

  // Ideal avg 30-50. Anything over 50 decays.
  let s = 1;
  if (avgLen > 50) s -= Math.min(0.6, (avgLen - 50) * 0.03);
  s -= Math.min(0.5, longRatio * 1.5);
  s -= Math.min(0.4, chainRatio * 1.5);
  s = Math.max(0, s);

  notes.push(`avg sentence length: ${avgLen.toFixed(1)}`);
  if (longRatio > 0) notes.push(`long (>70) ratio: ${(longRatio * 100).toFixed(0)}%`);
  if (chainRatio > 0) notes.push(`chained (,3+) ratio: ${(chainRatio * 100).toFixed(0)}%`);
  return { name: "構文", weight: 20, score: s, notes };
}

function scoreStance(t: string): AxisScore {
  const notes: string[] = [];
  const guide =
    countMatches(t, /するといいよ/g) +
    countMatches(t, /すればいいんだ/g) +
    countMatches(t, /だいじょうぶ/g);
  const gently = countMatches(t, /してごらん/g); // soft teacher — ok but weaker
  const preachy = countMatches(t, /(してみてごらん|やってごらん)/g); // too preachy
  const horizontal =
    countMatches(t, /一緒に.{0,6}しよう/g) + countMatches(t, /みんなで.{0,6}しよう/g);
  const imperative = countMatches(t, /しなきゃ[。！]/g) + countMatches(t, /しろ[。！]/g);

  let s = 0.5;
  s += Math.min(0.5, guide * 0.2);
  s += Math.min(0.15, gently * 0.08);
  s -= Math.min(0.4, preachy * 0.3);
  s -= Math.min(0.5, horizontal * 0.5);
  s -= Math.min(0.3, imperative * 0.3);
  s = Math.max(0, Math.min(1, s));

  if (guide > 0) notes.push(`guide phrases: ${guide}`);
  if (preachy > 0) notes.push(`preachy (してみてごらん) (bad): ${preachy}`);
  if (horizontal > 0) notes.push(`horizontal (bad): ${horizontal}`);
  if (imperative > 0) notes.push(`imperative (bad): ${imperative}`);
  return { name: "姿勢", weight: 15, score: s, notes };
}

function scoreFraming(t: string): AxisScore {
  const notes: string[] = [];
  // Look at first ~160 chars of prose for empathy before tool enumeration.
  const head = t.trim().slice(0, 200);
  const empathy =
    /(したいんだね|したいのかい|困ってるのかい|困ったね|したいの？|で困ってる？|で困ってるの)/.test(head);
  // Mind-reading / therapist opener is worse than no opener.
  const mindReading =
    /(と思っているのが分かった|気持ちが分かった|のが分かったよ|きみが.{0,20}と思って)/.test(head);
  const jumpsToTool = /^(-\s|•|\*)/m.test(head);

  let s = 0.5;
  if (empathy) {
    s += 0.4;
    notes.push("empathy opener (situational) detected");
  }
  if (mindReading) {
    s -= 0.5;
    notes.push("mind-reading opener (very bad)");
  }
  if (jumpsToTool && !empathy) {
    s -= 0.2;
    notes.push("jumps straight to tool list");
  }
  s = Math.max(0, Math.min(1, s));
  return { name: "順番", weight: 15, score: s, notes };
}

function scoreRestraint(t: string): AxisScore {
  const notes: string[] = [];
  const catchRe = /(やれやれ|バカだなあ|どうしたの)/g;
  const total = countMatches(t, catchRe);
  // Detect "catchphrase at paragraph start" (after newline or BOF, up to 4 chars whitespace)
  const asOpener = countMatches(t, /(^|\n)\s*(やれやれ|バカだなあ|どうしたの)/g);
  let s = 1;
  if (total > 1) s -= Math.min(0.4, (total - 1) * 0.25);
  if (asOpener > 0) {
    s -= Math.min(0.6, asOpener * 0.5);
    notes.push(`catchphrase as opener (bad): ${asOpener}`);
  }
  if (total > 0) notes.push(`catchphrases total: ${total}`);
  s = Math.max(0, s);
  return { name: "抑制", weight: 15, score: s, notes };
}

export function score(raw: string): ScoreReport {
  const t = strip(raw);
  const axes = [
    scoreEndings(t),
    scoreVocabulary(t),
    scoreSyntax(t),
    scoreStance(t),
    scoreFraming(t),
    scoreRestraint(t),
  ];
  const total = Math.round(axes.reduce((a, x) => a + x.score * x.weight, 0));
  return { total, axes };
}

function formatHuman(r: ScoreReport): string {
  const lines: string[] = [];
  lines.push(`score: ${r.total}/100`);
  for (const a of r.axes) {
    const pts = Math.round(a.score * a.weight);
    const bar = "█".repeat(Math.max(0, Math.round(a.score * 10)));
    lines.push(`  ${a.name.padEnd(4)} ${pts.toString().padStart(2)}/${a.weight}  ${bar.padEnd(10)}  ${a.notes.join(", ")}`);
  }
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  const src = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const r = score(src);
  if (json) process.stdout.write(JSON.stringify(r) + "\n");
  else process.stdout.write(formatHuman(r) + "\n");
}

const isEntry =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("score-dora.ts") || process.argv[1].endsWith("score-dora.js"));
if (isEntry) main();
