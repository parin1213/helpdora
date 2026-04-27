# helpdora

コマンドの要点を日本語で素早く教えてくれる CLI。LM Studio などの OpenAI 互換エンドポイントに接続して動作します。

```bash
# SUMMARY — コマンドの要点＋よく使うレシピ
helpdora ls
helpdora git commit

# INTENT — コマンドを指定してタスク別レシピ
helpdora ls "サブディレクトリ全部見たい"
helpdora git commit "WIP として保存したい"

# LOOKUP — コマンド名が分からない逆引き
helpdora "tarで*.tgzを解凍"
helpdora -p "pidを指定してプロセス殺す"

# FULL — 全オプションの逐語訳
helpdora --full ls
helpdora --full git commit

# ドラえもん口調
helpdora --dora ls

# キャッシュ管理
helpdora cache list
helpdora cache clear
helpdora --refresh ls

# プリキャッシュ: シェル履歴からトレンドのコマンドを事前取得
helpdora precache --dry-run      # 候補一覧だけ確認
helpdora precache                # 履歴読み取り確認 → 1 件で時間測定 → 続行確認
helpdora precache -y --limit 10  # 全自動
```

## 4 つのモード

引数の形から自動判定します:

| モード  | 判定条件                                  | 用途                             |
| ------- | ----------------------------------------- | -------------------------------- |
| SUMMARY | 既知コマンドのみ                          | 要点＋3〜5レシピ（デフォルト）   |
| INTENT  | 既知コマンド + 最後の引数に空白/非 ASCII  | そのコマンドでタスクを解決する例 |
| LOOKUP  | 先頭が未知 or `-p <text>`                 | 自然言語からコマンドを逆引き     |
| FULL    | `--full` 指定                             | 全オプションの逐語訳             |

## できること

- **SUMMARY / INTENT / FULL**: `<cmd> --help` → 失敗時 `man <cmd>` → `<cmd> -h` の順でローカルからヘルプを取得し、Markdown → ANSI にして表示
- **LOOKUP**: 推奨コマンド・解説・注意点・代替案を構造化 JSON で取得。LLM が知らないコマンドは `get_help` ツールを自動で呼んで確認する
- **キャッシュ**: LLM 応答を `~/.cache/helpdora/` に保存。2 回目以降は 1 秒以内。`--refresh` で上書き、`--no-cache` で無効化、`helpdora cache {list|clear|path}` で管理
- **ドラえもん口調 (`--dora`)**: 「〜だよ」「〜なんだ」調で説明（オプション）
- **OpenAI 互換**: LM Studio / Ollama / vLLM / OpenAI 本家など、`--base-url` で切り替え可能

## 前提

- Node.js 20 以上
- [LM Studio](https://lmstudio.ai/) が `http://localhost:1234/v1` で稼働（他のエンドポイントでも可）
- ローカルにロード済みモデル（tool-calling を使うなら function calling 対応モデル推奨）

## インストール

利用者向け:

```bash
npm i -g helpdora                  # npm
pnpm add -g helpdora               # pnpm
mise use -g npm:helpdora@latest    # mise
```

ソースからの開発インストール:

```bash
pnpm install
pnpm build
pnpm link --global      # ローカルビルドを `helpdora` として PATH に置く
```

## 使い方

### SUMMARY (デフォルト)

```bash
helpdora ls
helpdora git commit
helpdora docker compose up
```

### INTENT (コマンド + やりたいこと)

引数の最後が空白や日本語を含むとタスクとして解釈されます。

```bash
helpdora ls "サブディレクトリ全部見たい"
helpdora git "直前のコミット取り消したい"
helpdora rg "隠しファイル込みで grep"
```

### LOOKUP (逆引き)

先頭がコマンドとして見つからない or `-p` 指定時。

```bash
helpdora "tarで*.tgzを解凍"
helpdora -p "podのログをフォロー" --ctx kubectl   # 事前にヘルプを注入して精度UP
helpdora --no-tools -p "..."                     # LLM のヘルプ取得を無効化
```

### FULL (逐語訳)

```bash
helpdora --full ls
helpdora --full --raw awk     # 翻訳の下に原文も併記
helpdora --full --man tar     # man を強制ソースに
```

### プリキャッシュ (`helpdora precache`)

シェル履歴（`$HISTFILE` or `~/.zsh_history`）から頻出コマンド＋頻出サブコマンド pair を抽出し、SUMMARY を事前キャッシュします。オフライン前やデモ前に。

- **プライバシー**: 履歴の読み取り前に **必ず確認プロンプト** が出ます。`-y` で省略可
- **時間推定**: 1 件目の所要時間から全体時間を推定、`--threshold` 分超なら再確認
- **サブコマンド自動検出**: `git commit`, `mise use` などを頻度ベースで判定（誤検出避けに「3 種類以上の sub を観測」等のヒューリスティック）

```bash
helpdora precache --dry-run                        # 一覧だけ
helpdora precache --limit 10                       # 上位 10 件
helpdora precache --tone dora                      # ドラえもん口調版をキャッシュ
helpdora precache --mode full                      # 全オプション逐語訳もキャッシュ
helpdora precache --all                            # default/dora × summary/full の 4 variants
helpdora precache --history-file ~/.bash_history   # 別の履歴ファイルから
helpdora --provider claude precache --tone dora    # claude 経由で事前キャッシュ (高級)

# 直接指定（履歴スキャンなし、許可プロンプトもなし）
helpdora precache pup                              # pup + 自動検出 sub
helpdora precache git diff                         # git diff の SUMMARY だけ
helpdora precache pup --all                        # pup の 4 variants 全部
```

root の `--provider` / `--model` / `--base-url` は precache にも継承されます。同じコマンドでも provider ごとに別キャッシュが作られるので、`lm-studio` と `claude` を使い分ける運用も可能です。

### zsh 補完

```bash
# fpath に置いてグローバル有効化（初回のみ）
mkdir -p ~/.zfunc
helpdora completion zsh > ~/.zfunc/_helpdora
# ~/.zshrc に以下を追加（未設定なら）:
#   fpath=(~/.zfunc $fpath)
#   autoload -U compinit; compinit

# 一時的に試すだけ
eval "$(helpdora completion zsh)"
```

`helpdora <TAB>` でサブコマンド補完、`--provider <TAB>` で `lm-studio / claude / codex` 補完、`helpdora cache <TAB>` で `list / clear / path`、など。

### Claude Code 用スキルをインストール

```bash
helpdora install-skill
```

`~/.claude/skills/helpdora/SKILL.md` を書き出し、Claude Code から `/helpdora <args>` として呼べるようになります。

## 設定

### 環境変数（CLI 引数 > env > config.json > default）

| 変数                  | デフォルト                 | 説明                             |
| --------------------- | -------------------------- | -------------------------------- |
| `HELPDORA_BASE_URL`   | `http://localhost:1234/v1` | OpenAI 互換エンドポイント        |
| `HELPDORA_API_KEY`    | `lm-studio`                | ダミー値。本家を使う場合は実キー |
| `HELPDORA_MODEL`      | `qwen3.5-9b`               | 使用モデル ID                    |
| `HELPDORA_TIMEOUT_MS` | `120000`                   | リクエストタイムアウト (ms)      |

### 設定ファイル (`~/.config/helpdora/config.json`)

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "apiKey": "lm-studio",
  "model": "qwen3.5-9b",
  "timeoutMs": 120000
}
```

### OpenAI 本家を使う例

```bash
HELPDORA_BASE_URL=https://api.openai.com/v1 \
HELPDORA_API_KEY=sk-xxx \
HELPDORA_MODEL=gpt-4o-mini \
helpdora -p "..."
```

## 主なオプション

```
--full                FULL モード（全オプション逐語訳）
--man                 ヘルプ取得元を man に強制 (SUMMARY/FULL)
--raw                 翻訳の下に原文も併記 (SUMMARY/FULL)
--dora                ドラえもん口調で出力
--no-stream           一括出力 (パイプ用途)
--model <id>          モデル上書き
--base-url <url>      エンドポイント上書き
--provider <name>     lm-studio | claude | codex (default: lm-studio)
--ctx <cmd>           LOOKUP/INTENT で事前にヘルプを注入 (複数指定可)
--no-tools            LOOKUP/INTENT で LLM のツール呼び出しを無効化
--max-tool-calls <n>  ツール呼び出し上限 (default: 4)
--no-think-bypass     思考バイパスを無効化 (SUMMARY/FULL)
--no-cache            キャッシュ無効
--refresh             キャッシュを無視して再生成
--debug               タイミング・トークン数を stderr へ
```

## プロバイダ切り替え（高級オプション）

`--provider claude` または `--provider codex` で、認証済みの `claude` / `codex` CLI を経由して **賢いモデル**で翻訳できます（特に `--dora` のトーン遵守が格段に良くなる）。

```bash
helpdora --provider claude --dora ls
helpdora --provider codex ls
HELPDORA_PROVIDER=claude helpdora ls          # env で固定
```

制約 (v1):
- **SUMMARY / FULL のみ対応**。INTENT / LOOKUP は構造化出力が必要なため `lm-studio` 専用
- ストリーミングなし（subprocess 完了後に一括出力、間は spinner）
- `claude` / `codex` CLI が PATH にあり認証済みであること

## モード × フラグ対応表

| フラグ               | SUMMARY | INTENT | FULL | LOOKUP |
| -------------------- | :-----: | :----: | :--: | :----: |
| `--dora`             |    ✓    |   ✓    |  ✓   |   ✓    |
| `--man`              |    ✓    |   —    |  ✓   |   —    |
| `--raw`              |    ✓    |   —    |  ✓   |   —    |
| `--no-stream`        |    ✓    |   ✓    |  ✓   |   ✓    |
| `--no-think-bypass`  |    ✓    |   —    |  ✓   |   —    |
| `--no-tools`         |    —    |   ✓    |  —   |   ✓    |
| `--max-tool-calls`   |    —    |   ✓    |  —   |   ✓    |
| `--ctx`              |    —    |   ✓    |  —   |   ✓    |
| `--no-cache/refresh` |    ✓    |   ✓    |  ✓   |   ✓    |

## 終了コード

- `0` — 成功
- `1` — コマンドが見つからない / ヘルプが取得できない
- `2` — LLM 接続エラー・モデル未ロード
- `3` — その他の未分類エラー
- `64` — 引数不正

## 開発

```bash
pnpm dev ls                 # `tsx src/cli.ts ls` と同義
pnpm test                   # vitest
pnpm typecheck
pnpm build                  # dist/cli.js を生成
```

## 既知の制限

### 応答速度

- **SUMMARY / FULL は reasoning バイパスを自動適用**: Qwen3/3.5 系モデルでは `/v1/completions` を直接叩き `<think></think>` を prefix 挿入して思考パスを飛ばす（LM Studio の [bug #632](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/632) 回避）。`qwen3.5-9b` で従来 5 分が **約 1 分**まで短縮
- 無効化するなら `--no-think-bypass`（Jinja テンプレがズレている別モデル向け）
- INTENT / LOOKUP は構造化出力＋tool-calling のため現状 reasoning あり（2〜3 分）

### 精度

- LLM が提案するコマンドは **そのまま実行せず**、特に破壊的操作は内容を確認してから実行してください
- 出力には誤りが含まれる可能性があります。注意点（caveats）を必ず確認してください
- macOS の BSD 系と Linux の GNU 系でオプションが異なる場合があります

## License

MIT
