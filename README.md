# dora (旧 manju)

コマンドの `--help` / `man` を日本語に翻訳、あるいは日本語の要望からコマンドを逆引きする CLI。
LM Studio などの OpenAI 互換エンドポイントに接続して動作します。

```bash
dora ls                                       # ls のヘルプを日本語訳
dora git commit                               # サブコマンドのヘルプも OK
dora --man tar                                # man ページを強制ソースに
dora --dora ls                                # ドラえもん口調で翻訳
dora -p "tarで*.tgzを解凍するコマンドを教えて"   # 自然言語で逆引き
dora -p "podのログをフォロー" --ctx kubectl    # 事前にヘルプを注入して精度UP
dora cache list                               # キャッシュ一覧
dora --refresh ls                             # キャッシュ無視して再生成
```

## できること

- **ヘルプ翻訳**: `<cmd> --help` → 失敗時 `man <cmd>` → さらに失敗時 `<cmd> -h` の順でローカルからヘルプを取得し、Markdown 見出し・オプション名・例を保ちつつ日本語訳してストリーミング表示 (BSD 系ツールの `-h` は human-readable フラグを兼ねるため優先度は最後)。出力は **Markdown → ANSI 装飾** に変換済み（見出しカラー化、コードブロックは枠線＋シンタックスハイライト）。`--raw` で素の Markdown 取得可
- **自然言語 → コマンド逆引き** (`-p`): 推奨コマンド、短い解説、注意点、代替案を構造化 JSON で取得して色付き表示
- **LLM が知らないコマンドにも対応**: `-p` モードでは LLM が必要に応じて `get_help` ツールを呼び、その場で `--help` を読んで回答
- **キャッシュ**: LLM 応答を `~/.cache/dora/` に自動保存。同じコマンドの2回目以降は1秒以内。`--refresh` で上書き、`--no-cache` で無効化、`dora cache {list|clear|path}` で管理
- **ドラえもん口調 (`--dora`)**: 説明文を「〜だよ」「〜なんだ」「〜しよう」調に変換（オプション）
- **OpenAI 互換**: LM Studio / Ollama / vLLM / OpenAI 本家など、`baseURL` 差し替えだけで切り替え可能

## 前提

- Node.js 20 以上
- [LM Studio](https://lmstudio.ai/) が `http://localhost:1234/v1` で稼働（他のエンドポイントでも可）
- ローカルにロード済みモデル（tool-calling を使うなら function calling 対応モデル推奨）

## インストール

```bash
pnpm install
pnpm build
pnpm link --global      # グローバルに `dora` コマンドを配置
```

## 使い方

### ヘルプ翻訳モード

```bash
dora ls
dora git commit
dora --man tar
dora --raw awk         # 翻訳の下に原文も併記
```

### プロンプトモード

```bash
dora -p "gitで直前のコミットをundoしたい"
dora -p "ripgrepで隠しファイルも検索"
dora --no-tools -p "..."      # LLM のヘルプ取得を無効化
dora --ctx kubectl -p "podのログを見たい"   # 事前にヘルプ注入
```

### Claude Code 用スキルをインストール

```bash
dora install-skill
```
`~/.claude/skills/dora/SKILL.md` を書き出し、Claude Code から `/dora <args>` として呼べるようになります。

## 設定

### 環境変数（CLI 引数 > env > config.json > default）

| 変数 | デフォルト | 説明 |
|---|---|---|
| `DORA_BASE_URL` | `http://localhost:1234/v1` | OpenAI 互換エンドポイント |
| `DORA_API_KEY` | `lm-studio` | ダミー値。OpenAI 本家を使う場合は実キー |
| `DORA_MODEL` | `qwen3.5-9b` | 使用モデル ID |
| `DORA_TIMEOUT_MS` | `120000` | リクエストタイムアウト (ミリ秒) |

### 設定ファイル (`~/.config/dora/config.json`)

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
DORA_BASE_URL=https://api.openai.com/v1 \
DORA_API_KEY=sk-xxx \
DORA_MODEL=gpt-4o-mini \
dora -p "..."
```

## 主なオプション

```
--model <id>          モデル上書き
--base-url <url>      エンドポイント上書き
--man                 man ページを強制ソースに
--raw                 翻訳と原文を併記
--no-stream           一括出力 (パイプ用)
--ctx <cmd>           -p モードで事前にヘルプを注入 (複数指定可)
--no-tools            -p モードで LLM のツール呼び出しを無効化
--max-tool-calls <n>  ツール呼び出し上限 (default: 4)
--debug               タイミング・トークン数・ツール呼び出しを stderr へ
```

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
- **翻訳モードは reasoning バイパスを自動適用**: Qwen3/3.5 系モデルでは `/v1/completions` を直接叩き `<think></think>` を prefix 挿入して思考パスを飛ばす（LM Studio の [bug #632](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/632) 回避）。`qwen3.5-9b` で従来 5 分が **約 1 分**まで短縮
- 無効化するなら `--no-think-bypass`（Jinja テンプレがズレている別モデル向け）
- プロンプトモード (`-p`) は構造化出力＋tool-calling のため現状 reasoning あり（2〜3 分）
- `nippo` 側と揃えて `qwen3.5-9b` を使い回すとロード済みを共有できる（ユニファイドメモリが楽）

### 精度
- LLM が提案するコマンドは **そのまま実行せず**、特に破壊的操作は内容を確認してから実行してください
- 出力には誤りが含まれる可能性があります。`caveats` セクションを必ず確認してください
- macOS の BSD 系コマンドと Linux の GNU 系コマンドでオプションが異なる場合があります（プロンプトモードでは `caveats` で言及されます）

## License

MIT
