import { describe, it, expect } from "vitest";
import { detectMode } from "../src/mode-detect.js";

describe("detectMode", () => {
  it("no args → help", async () => {
    const m = await detectMode([], {});
    expect(m.kind).toBe("help");
  });

  it("known command only → summary", async () => {
    const m = await detectMode(["ls"], {});
    expect(m).toEqual({ kind: "summary", cmd: "ls", args: [] });
  });

  it("known command + subcommand → summary with args", async () => {
    const m = await detectMode(["git", "commit"], {});
    expect(m).toEqual({ kind: "summary", cmd: "git", args: ["commit"] });
  });

  it("known command + japanese intent → intent", async () => {
    const m = await detectMode(["ls", "サブディレクトリ全部見たい"], {});
    expect(m).toEqual({
      kind: "intent",
      cmd: "ls",
      args: [],
      intent: "サブディレクトリ全部見たい",
    });
  });

  it("known command + subcmd + intent with space → intent", async () => {
    const m = await detectMode(["git", "commit", "WIP で保存"], {});
    expect(m).toEqual({
      kind: "intent",
      cmd: "git",
      args: ["commit"],
      intent: "WIP で保存",
    });
  });

  it("unknown first token with natural-language → lookup", async () => {
    const m = await detectMode(["tarで", "解凍したい"], {});
    expect(m).toEqual({ kind: "lookup", intent: "tarで 解凍したい" });
  });

  it("unknown first token, no natural-language → CommandNotFoundError", async () => {
    await expect(detectMode(["__no_such_cmd_xyz__"], {})).rejects.toThrow();
  });

  it("-p maps to lookup", async () => {
    const m = await detectMode([], { prompt: "tarで解凍" });
    expect(m).toEqual({ kind: "lookup", intent: "tarで解凍" });
  });

  it("-p with positional is rejected", async () => {
    await expect(detectMode(["ls"], { prompt: "hi" })).rejects.toThrow();
  });

  it("--full + cmd → full mode (no intent detection)", async () => {
    const m = await detectMode(["ls"], { full: true });
    expect(m).toEqual({ kind: "full", cmd: "ls", args: [] });
  });

  it("--full preserves all positional args verbatim", async () => {
    const m = await detectMode(["git", "commit"], { full: true });
    expect(m).toEqual({ kind: "full", cmd: "git", args: ["commit"] });
  });

  it("--full without cmd → error", async () => {
    await expect(detectMode([], { full: true })).rejects.toThrow();
  });

  it("--full combined with -p → error", async () => {
    await expect(detectMode([], { full: true, prompt: "hi" })).rejects.toThrow(
      /--full と -p/,
    );
  });
});
