import { describe, it, expect } from "vitest";
import { detectMode } from "../src/mode-detect.js";

const stubIsCommandAvailable = async (name: string): Promise<boolean> => name === "ls" || name === "git";

describe("detectMode", () => {
  it("no args -> help", async () => {
    const mode = await detectMode([], {});
    expect(mode.kind).toBe("help");
  });

  it("known command only -> summary", async () => {
    const mode = await detectMode(["ls"], { isCommandAvailable: stubIsCommandAvailable });
    expect(mode).toEqual({ kind: "summary", cmd: "ls", args: [] });
  });

  it("known command + subcommand -> summary with args", async () => {
    const mode = await detectMode(["git", "commit"], { isCommandAvailable: stubIsCommandAvailable });
    expect(mode).toEqual({ kind: "summary", cmd: "git", args: ["commit"] });
  });

  it("known command + natural-language intent -> intent", async () => {
    const mode = await detectMode(["ls", "show all subdirectories"], {
      isCommandAvailable: stubIsCommandAvailable,
    });
    expect(mode).toEqual({
      kind: "intent",
      cmd: "ls",
      args: [],
      intent: "show all subdirectories",
    });
  });

  it("known command + subcmd + intent with space -> intent", async () => {
    const mode = await detectMode(["git", "commit", "save as WIP"], {
      isCommandAvailable: stubIsCommandAvailable,
    });
    expect(mode).toEqual({
      kind: "intent",
      cmd: "git",
      args: ["commit"],
      intent: "save as WIP",
    });
  });

  it("unknown first token with natural-language -> lookup", async () => {
    const mode = await detectMode(["tar", "how to extract"], {
      isCommandAvailable: stubIsCommandAvailable,
    });
    expect(mode).toEqual({ kind: "lookup", intent: "tar how to extract" });
  });

  it("unknown first token, no natural-language -> CommandNotFoundError", async () => {
    await expect(
      detectMode(["__no_such_cmd_xyz__"], { isCommandAvailable: stubIsCommandAvailable }),
    ).rejects.toThrow();
  });

  it("-p maps to lookup", async () => {
    const mode = await detectMode([], { prompt: "how to extract tar" });
    expect(mode).toEqual({ kind: "lookup", intent: "how to extract tar" });
  });

  it("-p with positional is rejected", async () => {
    await expect(detectMode(["ls"], { prompt: "hi" })).rejects.toThrow();
  });

  it("--full + cmd -> full mode", async () => {
    const mode = await detectMode(["ls"], {
      full: true,
      isCommandAvailable: stubIsCommandAvailable,
    });
    expect(mode).toEqual({ kind: "full", cmd: "ls", args: [] });
  });

  it("--full preserves all positional args verbatim", async () => {
    const mode = await detectMode(["git", "commit"], {
      full: true,
      isCommandAvailable: stubIsCommandAvailable,
    });
    expect(mode).toEqual({ kind: "full", cmd: "git", args: ["commit"] });
  });

  it("--full without cmd -> error", async () => {
    await expect(detectMode([], { full: true })).rejects.toThrow();
  });

  it("--full combined with -p -> error", async () => {
    await expect(detectMode([], { full: true, prompt: "hi" })).rejects.toThrow(/--full.*-p/);
  });
});
