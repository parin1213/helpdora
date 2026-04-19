// Self-improving Doraemon-tone loop.
//
// Each iteration:
//   1. pnpm build (only if src/tone/doraemon.ts changed)
//   2. generate --dora outputs for a fixed test suite
//   3. score with scripts/score-dora.ts (6-axis rubric)
//   4. pick the worst-scoring axis
//   5. apply the next unused patch for that axis from the registry
//   6. log everything to logs/dora-tone/iter-NN.md
//
// Stop conditions: avg score >= TARGET, patches exhausted, or max iterations.
import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { score, type ScoreReport } from "./score-dora.js";

const REPO = process.cwd();
const TONE_FILE = join(REPO, "src/tone/doraemon.ts");
const LOG_DIR = join(REPO, "logs/dora-tone");
const CLI = [join(REPO, "node_modules/.bin/tsx"), join(REPO, "src/cli.ts")];

interface TestCase {
  label: string;
  args: string[];
}

const TESTS: TestCase[] = [
  { label: "summary--ls", args: ["--dora", "--no-cache", "--no-stream", "ls"] },
  { label: "summary--tar", args: ["--dora", "--no-cache", "--no-stream", "tar"] },
  {
    label: "intent--git",
    args: ["--dora", "--no-cache", "--no-stream", "git", "直前のコミット取り消したい"],
  },
];

const TARGET_SCORE = 78;
const MAX_ITERATIONS = 8;

interface Patch {
  id: string;
  axis: "語尾" | "語彙" | "構文" | "姿勢" | "順番" | "抑制";
  /** Unique marker that, if present in the tone file, means this patch is applied. */
  marker: string;
  /** Full multiline block appended to DORAEMON_CORE just before the closing backtick. */
  block: string;
}

const PATCHES: Patch[] = [
  {
    id: "strict-ornamental-endings",
    axis: "語尾",
    marker: "<!-- patch: strict-ornamental-endings -->",
    block: `
厳守（語尾）:
- 1 出力中に「〜のさ」「〜のだ」「〜だぜ」「〜なのさ」を **1 回も使わない**
- 疑わしい語尾は「〜なんだ」「〜だよ」「〜できるよ」に置き換える`,
  },
  {
    id: "forbidden-tool-words",
    axis: "語彙",
    marker: "<!-- patch: forbidden-tool-words -->",
    block: `
厳守（語彙）:
- 「魔法の道具」「魔法のツール」「便利グッズ」「スーパー道具」は禁止。代わりに **「ひみつ道具」** のみ使う
- 「〜するんだ」の連発を避け、短い体言止めも混ぜる`,
  },
  {
    id: "sentence-length",
    axis: "構文",
    marker: "<!-- patch: sentence-length -->",
    block: `
厳守（構文）:
- **1 文は 40 字以内**。長くなりそうなら句点で区切り、次の文にする
- 「〜し、〜し、〜するんだ」のような並置は 2 要素まで。3 要素以上は句点で分割
- 短い平叙文を 2〜3 並べてから「だいじょうぶ」などのひとこと安心を入れる`,
  },
  {
    id: "guide-form",
    axis: "姿勢",
    marker: "<!-- patch: guide-form -->",
    block: `
厳守（姿勢）:
- 「一緒に〜しよう」「みんなで〜しよう」は禁止
- 案内形（「〜するといいよ」「〜すればいいんだ」「〜してごらん」）で締める
- 「〜してね」ではなく「〜するといいよ」のほうが **ドラえもん寄り**`,
  },
  // NOTE: the "intent-empathy-opener" patch was removed after it polluted
  // SUMMARY/FULL outputs with mind-reading openers (the patch was appended
  // to DORAEMON_CORE, which is shared across modes). INTENT-specific rules
  // now live permanently in DORAEMON_INTENT_OPENER. If you want to iterate
  // on the INTENT opener, edit that constant directly — don't re-introduce
  // a CORE patch.
  {
    id: "catchphrase-restraint",
    axis: "抑制",
    marker: "<!-- patch: catchphrase-restraint -->",
    block: `
厳守（抑制）:
- 「やれやれ」「バカだなあ」「どうしたの」は **見出し・段落冒頭に置かない**
- 1 出力につき合計 1 回まで。文の中で、具体的な状況に対して使う
- 冠詞的な使用（「やれやれ、〜を出すか」）は禁止`,
  },
];

interface IterationResult {
  iter: number;
  avgScore: number;
  axisAverages: Record<string, number>;
  worstAxis: string;
  appliedPatch: string | null;
  outputs: { label: string; score: number; report: ScoreReport; text: string }[];
}

function runOnce(args: string[]): string {
  const r = spawnSync(CLI[0]!, [...CLI.slice(1), ...args], {
    encoding: "utf8",
    timeout: 300_000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function readTone(): string {
  return readFileSync(TONE_FILE, "utf8");
}

function writeTone(s: string): void {
  writeFileSync(TONE_FILE, s, "utf8");
}

function patchApplied(tone: string, p: Patch): boolean {
  return tone.includes(p.marker);
}

function nextPatchFor(axis: string, tone: string): Patch | null {
  return PATCHES.find((p) => p.axis === axis && !patchApplied(tone, p)) ?? null;
}

/** Append the patch's block (wrapped in its marker comment) to DORAEMON_CORE. */
function applyPatch(p: Patch): void {
  const tone = readTone();
  // Insert just before the closing backtick of DORAEMON_CORE.
  const core = /(export const DORAEMON_CORE = `[\s\S]*?)(`;)/;
  const m = tone.match(core);
  if (!m) throw new Error("DORAEMON_CORE not found in tone file");
  const insertion = `\n${p.marker}\n${p.block.trim()}\n${p.marker}\n`;
  const replaced = tone.replace(core, `$1${insertion}$2`);
  writeTone(replaced);
}

function build(): void {
  execSync("pnpm build", { cwd: REPO, stdio: "pipe" });
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, x) => a + x, 0) / nums.length;
}

function formatIteration(r: IterationResult, tone: string): string {
  const lines: string[] = [];
  lines.push(`# iteration ${r.iter}`);
  lines.push("");
  lines.push(`- avg score: **${r.avgScore.toFixed(1)}/100**`);
  lines.push(`- worst axis: **${r.worstAxis}**`);
  lines.push(`- applied patch: ${r.appliedPatch ?? "(none — exhausted or converged)"}`);
  lines.push("");
  lines.push("## axis averages");
  for (const [axis, v] of Object.entries(r.axisAverages)) {
    lines.push(`- ${axis}: ${(v * 100).toFixed(0)}%`);
  }
  lines.push("");
  lines.push("## per-case scores");
  for (const o of r.outputs) {
    lines.push(`### ${o.label} — ${o.score}/100`);
    for (const a of o.report.axes) {
      lines.push(`- ${a.name}: ${Math.round(a.score * a.weight)}/${a.weight}  (${a.notes.join("; ") || "—"})`);
    }
    lines.push("");
    lines.push("<details><summary>output</summary>");
    lines.push("");
    lines.push("```");
    lines.push(o.text.trim());
    lines.push("```");
    lines.push("</details>");
    lines.push("");
  }
  lines.push("## tone file (current)");
  lines.push("```ts");
  lines.push(tone);
  lines.push("```");
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  let previousAvg = 0;
  let stallCount = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    console.log(`\n=== iteration ${iter} ===`);
    try {
      build();
    } catch (e) {
      console.error(`build failed, aborting: ${(e as Error).message}`);
      break;
    }

    const outputs = TESTS.map((t) => {
      console.log(`  generating ${t.label}...`);
      const text = runOnce(t.args);
      const report = score(text);
      console.log(`    score: ${report.total}/100`);
      return { label: t.label, text, score: report.total, report };
    });

    const avgScore = average(outputs.map((o) => o.score));
    const axisAverages: Record<string, number> = {};
    const axisNames = outputs[0]!.report.axes.map((a) => a.name);
    for (const name of axisNames) {
      axisAverages[name] = average(
        outputs.map((o) => o.report.axes.find((a) => a.name === name)!.score),
      );
    }
    const worstAxis = Object.entries(axisAverages).sort((a, b) => a[1] - b[1])[0]![0];

    const tone = readTone();
    const patch = nextPatchFor(worstAxis, tone);
    const result: IterationResult = {
      iter,
      avgScore,
      axisAverages,
      worstAxis,
      appliedPatch: patch?.id ?? null,
      outputs,
    };

    writeFileSync(
      join(LOG_DIR, `iter-${String(iter).padStart(2, "0")}.md`),
      formatIteration(result, tone),
      "utf8",
    );
    console.log(`  avg=${avgScore.toFixed(1)}  worst=${worstAxis}  patch=${patch?.id ?? "(none)"}`);

    if (avgScore >= TARGET_SCORE) {
      console.log(`converged: avg ${avgScore.toFixed(1)} >= target ${TARGET_SCORE}`);
      break;
    }
    if (!patch) {
      // No patches left for worst axis. Try 2nd-worst.
      const sortedAxes = Object.entries(axisAverages).sort((a, b) => a[1] - b[1]);
      let applied: Patch | null = null;
      for (const [ax] of sortedAxes) {
        const p = nextPatchFor(ax, tone);
        if (p) {
          applied = p;
          break;
        }
      }
      if (!applied) {
        console.log("all patches exhausted, stopping");
        break;
      }
      console.log(`  fallback patch: ${applied.id} (for ${applied.axis})`);
      applyPatch(applied);
    } else {
      applyPatch(patch);
    }

    // Stall detection
    if (Math.abs(avgScore - previousAvg) < 1.5) stallCount++;
    else stallCount = 0;
    if (stallCount >= 2) {
      console.log("score plateaued, stopping");
      break;
    }
    previousAvg = avgScore;
  }

  console.log("\nimprovement loop finished. see logs/dora-tone/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
