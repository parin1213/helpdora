// Heuristic Doraemon-tone scorer. Reads stdin (or argv[2] as a file path)
// and prints a 0..100 score plus a breakdown of hits/misses.
import { readFileSync } from "node:fs";

interface Rule {
  name: string;
  weight: number;
  test: (text: string) => number;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

// Tuned for command-help translation context: first-person「ぼく」 rarely
// arises, so weight is small. The Doraemon feel mostly comes from
// informal explanatory endings 〜んだ/〜だよ/〜ね, so those are the
// primary signals.
const rules: Rule[] = [
  {
    name: "文末「〜だよ」",
    weight: 5,
    test: (t) => Math.min(6, countMatches(t, /だよ[。！？\n]/g)),
  },
  {
    name: "文末「〜なんだ」",
    weight: 6,
    test: (t) => Math.min(5, countMatches(t, /なんだ[。！？\n]/g)),
  },
  {
    name: "文末「〜んだ」(〜なんだ除く)",
    weight: 4,
    test: (t) => Math.min(6, countMatches(t, /(?<!な)んだ[。！？\n]/g)),
  },
  {
    name: "文末「〜ね」",
    weight: 3,
    test: (t) => Math.min(6, countMatches(t, /[るだ]ね[。！？\n]/g)),
  },
  {
    name: "文末「〜よ」(〜だよ除く)",
    weight: 2,
    test: (t) => Math.min(5, countMatches(t, /(?<!だ)よ[。！？\n]/g)),
  },
  {
    name: "文末「〜しよう」",
    weight: 3,
    test: (t) => Math.min(3, countMatches(t, /しよう[。！？\n]/g)),
  },
  {
    name: "文末「〜のさ/〜のだ」",
    weight: 2,
    test: (t) => Math.min(3, countMatches(t, /(のさ|のだ)[。！？\n]/g)),
  },
  {
    name: "一人称「ぼく」(任意)",
    weight: 2,
    test: (t) => Math.min(2, countMatches(t, /ぼく/g)),
  },
  {
    name: "ドラえもん口癖",
    weight: 8,
    test: (t) =>
      (countMatches(t, /やれやれ/g) > 0 ? 1 : 0) +
      (countMatches(t, /バカだな/g) > 0 ? 1 : 0) +
      (countMatches(t, /どうしたの/g) > 0 ? 1 : 0),
  },
  {
    name: "【減点】です・ます調",
    weight: -10,
    test: (t) => countMatches(t, /(です[。、\n]|ます[。、\n])/g),
  },
  {
    name: "【減点】「〜である」",
    weight: -5,
    test: (t) => countMatches(t, /である[。\n]/g),
  },
  {
    name: "【減点】堅い「〜する。」終止",
    weight: -2,
    test: (t) => Math.min(10, countMatches(t, /(指定する|実行する|表示する|出力する)[。\n]/g)),
  },
];

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function strip(t: string): string {
  // Drop code blocks + inline code + headings that won't be touched
  let s = stripAnsi(t);
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`[^`]+`/g, "");
  return s;
}

function score(text: string): {
  score: number;
  raw: number;
  max: number;
  breakdown: { name: string; hits: number; points: number }[];
} {
  const body = strip(text);
  const breakdown: { name: string; hits: number; points: number }[] = [];
  let raw = 0;
  let max = 0;
  for (const r of rules) {
    const hits = r.test(body);
    const points = hits * r.weight;
    breakdown.push({ name: r.name, hits, points });
    raw += points;
    if (r.weight > 0) max += r.weight * 3; // rough positive cap
  }
  const normalized = Math.max(0, Math.min(100, Math.round((raw / max) * 100)));
  return { score: normalized, raw, max, breakdown };
}

const src = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
const r = score(src);
console.log(`score: ${r.score}/100  (raw=${r.raw}, max=${r.max})`);
for (const b of r.breakdown) {
  const icon = b.points > 0 ? "+" : b.points < 0 ? "-" : " ";
  console.log(`  ${icon} ${b.name.padEnd(28)} hits=${String(b.hits).padStart(2)}  pts=${b.points}`);
}
