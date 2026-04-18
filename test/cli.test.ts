import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = ["./node_modules/.bin/tsx", "src/cli.ts"];

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(CLI[0]!, [...CLI.slice(1), ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

describe("cli", () => {
  it("--version prints version", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help shows usage", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("manju");
    expect(r.stdout).toContain("--prompt");
    expect(r.stdout).toContain("install-skill");
  });

  it("unknown command exits 1", () => {
    const r = run(["__nothing_cmd_xyz__"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("コマンドが見つかりません");
  });

  it("-p with positional cmd rejects", () => {
    const r = run(["-p", "hello", "ls"]);
    expect(r.code).toBe(64);
  });

  it("install-skill --dir writes SKILL.md", () => {
    const tmp = mkdtempSync(join(tmpdir(), "manju-skill-"));
    try {
      const r = run(["install-skill", "--dir", tmp]);
      expect(r.code).toBe(0);
      const f = join(tmp, "manju", "SKILL.md");
      expect(existsSync(f)).toBe(true);
      const body = readFileSync(f, "utf8");
      expect(body).toContain("name: manju");
      expect(body).toContain("/manju");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("install-skill refuses to overwrite without --force", () => {
    const tmp = mkdtempSync(join(tmpdir(), "manju-skill-"));
    try {
      run(["install-skill", "--dir", tmp]);
      // Tweak the installed file so the idempotent-reinstall path doesn't short-circuit
      const f = join(tmp, "manju", "SKILL.md");
      const original = readFileSync(f, "utf8");
      require("node:fs").writeFileSync(f, original + "\n# edited\n", "utf8");
      const r2 = run(["install-skill", "--dir", tmp]);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toContain("already exists");
      const r3 = run(["install-skill", "--dir", tmp, "--force"]);
      expect(r3.code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}, { timeout: 30_000 });
