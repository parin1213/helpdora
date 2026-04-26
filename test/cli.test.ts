import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = [process.execPath, "--import", "tsx", "src/cli.ts"];

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(CLI[0]!, [...CLI.slice(1), ...args], {
    cwd: "C:\\dev\\src\\dora",
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? -1,
  };
}

describe("cli", () => {
  it("--version prints version", () => {
    const result = run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help shows usage", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("helpdora");
    expect(result.stdout).toContain("--prompt");
    expect(result.stdout).toContain("install-skill");
  });

  it("unknown command exits 1", () => {
    const result = run(["__nothing_cmd_xyz__"]);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("-p with positional cmd rejects", () => {
    const result = run(["-p", "hello world", "ls"]);
    expect(result.code).toBe(64);
  });

  it("install-skill --dir writes SKILL.md", () => {
    const tmp = mkdtempSync(join(tmpdir(), "helpdora-skill-"));
    try {
      const result = run(["install-skill", "--dir", tmp]);
      expect(result.code).toBe(0);
      const filePath = join(tmp, "helpdora", "SKILL.md");
      expect(existsSync(filePath)).toBe(true);
      const body = readFileSync(filePath, "utf8");
      expect(body).toContain("name: helpdora");
      expect(body).toContain("/helpdora");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("install-skill refuses to overwrite without --force", () => {
    const tmp = mkdtempSync(join(tmpdir(), "helpdora-skill-"));
    try {
      run(["install-skill", "--dir", tmp]);
      const filePath = join(tmp, "helpdora", "SKILL.md");
      const original = readFileSync(filePath, "utf8");
      writeFileSync(filePath, original + "\n# edited\n", "utf8");

      const result = run(["install-skill", "--dir", tmp]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("already exists");

      const forced = run(["install-skill", "--dir", tmp, "--force"]);
      expect(forced.code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}, { timeout: 30_000 });
