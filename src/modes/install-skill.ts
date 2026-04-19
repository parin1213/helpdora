import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import pc from "picocolors";
import { writeDim, writeError, writeLine } from "../render.js";

const SKILL_NAME = "dora";

export interface InstallSkillOptions {
  force?: boolean;
  dir?: string;
}

export function installSkill(opts: InstallSkillOptions = {}): number {
  const skillsRoot = opts.dir ?? join(homedir(), ".claude", "skills");
  const skillDir = join(skillsRoot, SKILL_NAME);
  const skillFile = join(skillDir, "SKILL.md");

  if (existsSync(skillFile) && !opts.force) {
    const existing = readFileSync(skillFile, "utf8");
    if (existing === skillContent()) {
      writeDim(`already up-to-date: ${skillFile}`);
      return 0;
    }
    writeError(`already exists: ${skillFile}`);
    writeLine(`  ${pc.dim("--force で上書きできます")}`);
    return 1;
  }

  try {
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, skillContent(), "utf8");
  } catch (e) {
    writeError(`skill install failed: ${(e as Error).message}`);
    return 2;
  }

  writeLine(pc.green("✓ ") + `installed skill: ${pc.cyan(skillFile)}`);
  writeLine();
  writeDim("Claude Code を再起動後、以下で呼び出せます:");
  writeLine("  /dora ls                    # ls のヘルプを翻訳");
  writeLine('  /dora -p "tarで解凍したい"   # 自然言語で逆引き');
  return 0;
}

function skillContent(): string {
  return `---
name: dora
description: ローカルの dora CLI を使い、シェルコマンドの要点・タスク別レシピ・自然言語からの逆引きを日本語で取得する。Use when the user runs \`/dora\` or asks to summarize a command, get a recipe for a specific task with a known command, look up a command by intent, or produce a full option-by-option translation.
---

# /dora スキル実行手順

ユーザーが \`/dora\` を発動したら、引数を**そのまま** \`dora\` CLI に渡す。LM Studio など OpenAI 互換エンドポイントに接続して実行され、日本語で結果が返る。

## 4 つのモード

dora は引数から自動で以下のモードを選ぶ:

| モード  | 例                               | 内容                           |
| ------- | -------------------------------- | ------------------------------ |
| SUMMARY | \`/dora ls\`                     | 要点＋よく使うレシピ 3〜5 個   |
| INTENT  | \`/dora git "直前のコミット取消"\` | コマンド指定でタスク別レシピ   |
| LOOKUP  | \`/dora "tarで解凍"\`            | 自然言語からコマンドを逆引き   |
| FULL    | \`/dora --full ls\`              | 全オプションの逐語訳           |

## 実行方法

Bash ツールで以下を実行し、\`stdout\` をそのままユーザーに提示する:

\`\`\`bash
dora <ユーザーが渡した全引数>
\`\`\`

引数は**一切加工せず**そのまま渡すこと（スペース・クォート・オプションも含めて）。
\`dora\` の終了コード:
- \`0\`: 成功
- \`1\`: コマンドが見つからない／ヘルプが取得できない
- \`2\`: LLM 接続エラー（LM Studio サーバ未起動など）
- \`64\`: 引数不正

## 前提

- \`dora\` が PATH に存在すること（\`which dora\` で確認）
- LM Studio サーバが \`http://localhost:1234/v1\` で起動していること、
  または \`DORA_BASE_URL\` 環境変数で別エンドポイントが設定されていること
- 設定は \`~/.config/dora/config.json\` or \`DORA_*\` 環境変数で調整可能

## 注意

- 提案されたコマンドは **そのまま実行せず**、ユーザーに確認してもらうこと（特に破壊的操作）
- \`dora\` は LLM を介するため、出力に誤りが含まれる可能性がある。注意点（caveats）セクションを重視すること
`;
}
