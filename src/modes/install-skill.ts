import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import pc from "picocolors";
import { writeDim, writeError, writeLine } from "../render.js";

const SKILL_NAME = "helpdora";

export type InstallSkillOptions = {
  force?: boolean;
  dir?: string;
};

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
  writeLine("  /helpdora ls                    # ls のヘルプを翻訳");
  writeLine('  /helpdora -p "tarで解凍したい"   # 自然言語で逆引き');
  return 0;
}

function skillContent(): string {
  return `---
name: helpdora
description: ローカルの helpdora CLI を使い、シェルコマンドの要点・タスク別レシピ・自然言語からの逆引きを日本語で取得する。Use when the user runs \`/helpdora\` or asks to summarize a command, get a recipe for a specific task with a known command, look up a command by intent, or produce a full option-by-option translation.
---

# /helpdora スキル実行手順

ユーザーが \`/helpdora\` を発動したら、引数を**そのまま** \`helpdora\` CLI に渡す。LM Studio など OpenAI 互換エンドポイントに接続して実行され、日本語で結果が返る。

## 4 つのモード

helpdora は引数から自動で以下のモードを選ぶ:

| モード  | 例                                    | 内容                           |
| ------- | ------------------------------------- | ------------------------------ |
| SUMMARY | \`/helpdora ls\`                      | 要点＋よく使うレシピ 3〜5 個   |
| INTENT  | \`/helpdora git "直前のコミット取消"\` | コマンド指定でタスク別レシピ   |
| LOOKUP  | \`/helpdora "tarで解凍"\`             | 自然言語からコマンドを逆引き   |
| FULL    | \`/helpdora --full ls\`               | 全オプションの逐語訳           |

## 主なオプション

- \`--dora\` ドラえもん口調
- \`--provider lm-studio|claude|codex\` プロバイダ切り替え（claude/codex は SUMMARY/FULL のみ、INTENT/LOOKUP は lm-studio 必須）
- \`--man\` / \`--raw\` / \`--no-stream\` / \`--no-cache\` / \`--refresh\`

## サブコマンド

- \`/helpdora cache list|clear|path [pattern]\` キャッシュ管理（\`clear <pattern>\` で部分一致削除）
- \`/helpdora precache\` 履歴から頻出コマンドを事前キャッシュ。\`/helpdora precache <cmd> [sub]\` で直接指定も可。\`--tone dora\` / \`--mode full\` / \`--all\`、\`--provider\` 継承
- \`/helpdora completion zsh\` zsh 補完スクリプト（fzf-tab 対応）
- \`/helpdora install-skill\` このスキルファイル自体の再インストール

## 実行方法

Bash ツールで以下を実行し、\`stdout\` をそのままユーザーに提示する:

\`\`\`bash
helpdora <ユーザーが渡した全引数>
\`\`\`

引数は**一切加工せず**そのまま渡すこと（スペース・クォート・オプションも含めて）。
\`helpdora\` の終了コード:
- \`0\`: 成功
- \`1\`: コマンドが見つからない／ヘルプが取得できない
- \`2\`: LLM 接続エラー（LM Studio サーバ未起動 / 空応答でコンテキスト超過の可能性）
- \`3\`: その他の実行時エラー
- \`64\`: 引数不正

## 前提

- \`helpdora\` が PATH に存在すること（\`which helpdora\` で確認）
- LM Studio サーバが \`http://localhost:1234/v1\` で起動、または \`HELPDORA_BASE_URL\` で別エンドポイント
- \`--provider claude\` 使用時は \`claude\` CLI が PATH にあり認証済み
- \`--provider codex\` 使用時は \`codex\` CLI が PATH にあり認証済み
- 設定は \`~/.config/helpdora/config.json\` or \`HELPDORA_*\` 環境変数で調整可能

## 注意

- 提案されたコマンドは **そのまま実行せず**、ユーザーに確認してもらうこと（特に破壊的操作）
- \`helpdora\` は LLM を介するため、出力に誤りが含まれる可能性がある。注意点（caveats）セクションを重視すること
- \`precache\` は履歴ファイルを読むので、privacy 確認プロンプトが出る。\`-y\` で省略可
`;
}
