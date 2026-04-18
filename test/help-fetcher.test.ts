import { describe, it, expect } from "vitest";
import { fetchHelp, CommandNotFoundError, HelpNotFoundError } from "../src/help-fetcher.js";

describe("fetchHelp", () => {
  it("throws CommandNotFoundError for unknown command", async () => {
    await expect(fetchHelp("__not_a_command_xyz__")).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it("rejects shell-unsafe command names", async () => {
    await expect(fetchHelp("foo; rm -rf /")).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it("fetches --help for `ls`", async () => {
    const r = await fetchHelp("ls");
    expect(r.text.length).toBeGreaterThan(0);
    expect(["help", "short-help", "man"]).toContain(r.source);
  });

  it("honors --man-only", async () => {
    const r = await fetchHelp("ls", [], { source: "man" });
    expect(r.source).toBe("man");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("passes subcommand args through", async () => {
    // `git commit --help` should include the word "commit"
    const r = await fetchHelp("git", ["commit"]);
    expect(r.text.toLowerCase()).toContain("commit");
  });

  it("truncates huge output", async () => {
    const r = await fetchHelp("ls", [], { maxBytes: 50 });
    const bytes = Buffer.byteLength(r.text, "utf8");
    expect(bytes).toBeLessThanOrEqual(50 + "\n...[truncated]".length + 4);
  });

  it("resolves a shell-function wrapper (z → zoxide) when zoxide is installed", async () => {
    // Skip if zoxide/z aren't installed on this machine
    const { spawnSync } = await import("node:child_process");
    const zoxide = spawnSync("which", ["zoxide"], { encoding: "utf8" });
    if (zoxide.status !== 0) return;
    const zDef = spawnSync(process.env.SHELL || "/bin/zsh", ["-ic", "type z"], { encoding: "utf8" });
    if (!/function|alias/.test(zDef.stdout + zDef.stderr)) return;

    const r = await fetchHelp("z");
    expect(r.cmd).toBe("zoxide");
    expect(r.text.length).toBeGreaterThan(50);
  });
}, { timeout: 15_000 });
