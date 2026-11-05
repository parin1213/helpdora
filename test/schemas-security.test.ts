import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import OpenAI from "openai";
import { MAX_ANSWER_ITEMS, PromptAnswer } from "../src/schemas.js";

const answer = { command: "echo ok", explanation: "ok", caveats: [], sources: [], alternatives: [] };
const fields = ["caveats", "sources", "alternatives"] as const;

describe("structured answer limits", () => {
  for (const field of fields) {
    it(`accepts ${field} at the limit and rejects limit + 1`, () => {
      const element = field === "alternatives" ? { command: "ls", when: "ok" } : "ok";
      const value = { ...answer, [field]: Array(MAX_ANSWER_ITEMS).fill(element) };
      expect(PromptAnswer.parse(value)).toEqual(value);
      expect(PromptAnswer.safeParse({ ...value, [field]: Array(MAX_ANSWER_ITEMS + 1).fill(element) }).success).toBe(false);
    });

    it(`rejects oversized ${field} before reading an element`, () => {
      const elements = Array(MAX_ANSWER_ITEMS + 1).fill(null);
      Object.defineProperty(elements, 0, { get() { throw new Error("element visited"); } });
      expect(() => PromptAnswer.parse({ ...answer, [field]: elements })).toThrow(z.ZodError);
    });

    it(`bounds errors for cached JSON with 100000 invalid ${field}`, () => {
      const raw = JSON.stringify({ ...answer, [field]: Array(100000).fill(null) });
      const result = PromptAnswer.safeParse(JSON.parse(raw));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]).toMatchObject({ code: "too_big", path: [field] });
      }
    });
  }

  it("includes limits in the SDK wire schema", () => {
    const schema = zodResponseFormat(PromptAnswer, "command_suggestion").json_schema.schema as {
      properties: Record<string, { maxItems?: number }>;
    };
    for (const field of fields) expect(schema.properties[field]!.maxItems).toBe(MAX_ANSWER_ITEMS);
  });

  it("enforces the limit in the real SDK parsing path", async () => {
    let calls = 0;
    const client = new OpenAI({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({
          id: "test", object: "chat.completion", created: 0, model: "test",
          choices: [{ index: 0, finish_reason: "stop", message: {
            role: "assistant", refusal: null,
            content: JSON.stringify({ ...answer, caveats: Array(100000).fill(null) }),
          } }],
        }), { headers: { "content-type": "application/json" } });
      },
    });
    await expect(client.chat.completions.parse({
      model: "test", messages: [{ role: "user", content: "test" }],
      response_format: zodResponseFormat(PromptAnswer, "command_suggestion"),
    })).rejects.toMatchObject({ issues: [{ code: "too_big", path: ["caveats"] }] });
    expect(calls).toBe(1);
  });
});
