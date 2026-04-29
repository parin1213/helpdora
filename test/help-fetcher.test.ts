import { describe, it, expect } from "vitest";
import { fetchHelp, CommandNotFoundError } from "../src/help-fetcher.js";

describe("fetchHelp", () => {
  it("throws CommandNotFoundError for unknown command", async () => {
    await expect(fetchHelp("__not_a_command_xyz__")).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it("rejects shell-unsafe command names", async () => {
    await expect(fetchHelp("foo; rm -rf /")).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it("fetches help for `node`", async () => {
    const result = await fetchHelp("node");
    expect(result.text.length).toBeGreaterThan(0);
    expect(["help", "short-help", "man"]).toContain(result.source);
  });

  it("honors native help preference", async () => {
    const result = await fetchHelp("ls", [], { source: "man" });
    expect(result.source).toBe("man");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("passes extra args through", async () => {
    const result = await fetchHelp("node", ["--test"]);
    expect(result.text.toLowerCase()).toContain("--test");
  });

  it("truncates huge output", async () => {
    const result = await fetchHelp("node", [], { maxBytes: 50 });
    const bytes = Buffer.byteLength(result.text, "utf8");
    expect(bytes).toBeLessThanOrEqual(50 + "\n...[truncated]".length + 4);
  });

  it("resolves a shell-function wrapper (z -> zoxide) when available", async () => {
    if (process.platform === "win32") return;

    const { spawnSync } = await import("node:child_process");
    const zoxide = spawnSync("which", ["zoxide"], { encoding: "utf8" });
    if (zoxide.status !== 0) return;

    const zDef = spawnSync(process.env.SHELL || "/bin/zsh", ["-ic", "type z"], { encoding: "utf8" });
    if (!/function|alias/.test(zDef.stdout + zDef.stderr)) return;

    const result = await fetchHelp("z");
    expect(result.cmd).toBe("zoxide");
    expect(result.text.length).toBeGreaterThan(50);
  });
}, 15_000);
