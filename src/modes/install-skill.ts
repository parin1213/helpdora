import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import pc from "picocolors";
import { writeDim, writeError, writeLine } from "../render.js";

const SKILL_NAME = "manju";

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
  writeLine("  /manju ls                    # ls のヘルプを翻訳");
  writeLine('  /manju -p "tarで解凍したい"   # 自然言語で逆引き');
  return 0;
}

function skillContent(): string {
  return `---
name: manju
description: ローカルの manju CLI を使い、シェルコマンドの --help / man ページを日本語訳したり、自然言語の要望（"tarで*.tgzを解凍するコマンドを教えて" 等）から適切なコマンドを逆引きする。Use when the user runs \`/manju\` or asks to translate a command's help / look up a command by intent.
---

# /manju スキル実行手順

ユーザーが \`/manju\` を発動したら、引数を**そのまま** \`manju\` CLI に渡す。LM Studio など OpenAI 互換エンドポイントに接続して実行され、日本語で結果が返る。

## 使い方

### ヘルプ翻訳モード
\`\`\`
/manju ls
/manju git commit
/manju --man tar
\`\`\`
→ Bash ツールで \`manju <args>\` を起動し、出力（Markdown）をそのままユーザーに見せる。

### プロンプトモード（自然言語 → コマンド逆引き）
\`\`\`
/manju -p "tarで*.tgzを解凍するコマンドを教えて"
/manju -p "gitで直前のコミットをundoしたい"
/manju --ctx kubectl -p "podのログをフォローしたい"
\`\`\`
→ 構造化された結果（推奨コマンド＋解説＋注意点）が色付きで出力される。

## 実行方法

Bash ツールで以下を実行し、\`stdout\` をそのままユーザーに提示する:

\`\`\`bash
manju <ユーザーが渡した全引数>
\`\`\`

引数は**一切加工せず**そのまま渡すこと（スペース・クォート・オプションも含めて）。
\`manju\` の終了コード:
- \`0\`: 成功
- \`1\`: コマンドが見つからない／ヘルプが取得できない
- \`2\`: LLM 接続エラー（LM Studio サーバ未起動など）

## 前提

- \`manju\` が PATH に存在すること（\`which manju\` で確認）
- LM Studio サーバが \`http://localhost:1234/v1\` で起動していること、
  または \`MANJU_BASE_URL\` 環境変数で別エンドポイントが設定されていること
- 設定は \`~/.config/manju/config.json\` or \`MANJU_*\` 環境変数で調整可能

## 注意

- 提案されたコマンドは **そのまま実行せず**、ユーザーに確認してもらうこと（特に破壊的操作）
- \`manju\` は LLM を介するため、出力に誤りが含まれる可能性がある。\`caveats\` セクションを重視すること
`;
}
