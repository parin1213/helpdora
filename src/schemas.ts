import { z } from "zod";

export const PromptAnswer = z.object({
  command: z.string().describe("ユーザーのシェルにコピペして実行できる1行コマンド"),
  explanation: z.string().describe("日本語での短い解説（1〜3行）"),
  caveats: z
    .array(z.string())
    .describe("破壊的操作・権限・前提条件・プラットフォーム差異など、実行前に注意すべき点（日本語）。なければ空配列"),
  sources: z
    .array(z.string())
    .describe("参照したコマンドの --help などの情報源（例: 'tar --help', 'man find'）。内部知識のみで答えた場合は空配列"),
  alternatives: z
    .array(
      z.object({
        command: z.string(),
        when: z.string().describe("このコマンドが適切な状況（日本語）"),
      }),
    )
    .describe("代替案。必要なければ空配列"),
});

export type PromptAnswerT = z.infer<typeof PromptAnswer>;
