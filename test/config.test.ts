import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "helpdora-cfg-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: tmp, ...overrides };
}

describe("loadConfig", () => {
  it("returns defaults when nothing is set", () => {
    const cfg = loadConfig({}, env());
    expect(cfg.baseUrl).toBe("http://localhost:1234/v1");
    expect(cfg.model).toBe("qwen3.5-9b");
    expect(cfg.timeoutMs).toBe(120_000);
  });

  it("env overrides defaults", () => {
    const cfg = loadConfig({}, env({ HELPDORA_MODEL: "gpt-oss-20b" }));
    expect(cfg.model).toBe("gpt-oss-20b");
  });

  it("config file overrides defaults but not env", () => {
    mkdirSync(join(tmp, "helpdora"), { recursive: true });
    writeFileSync(
      join(tmp, "helpdora", "config.json"),
      JSON.stringify({ model: "from-file", baseUrl: "http://file/v1" }),
    );
    const cfg = loadConfig({}, env({ HELPDORA_MODEL: "from-env" }));
    expect(cfg.model).toBe("from-env");
    expect(cfg.baseUrl).toBe("http://file/v1");
  });

  it("cli overrides everything", () => {
    mkdirSync(join(tmp, "helpdora"), { recursive: true });
    writeFileSync(
      join(tmp, "helpdora", "config.json"),
      JSON.stringify({ model: "from-file" }),
    );
    const cfg = loadConfig(
      { model: "from-cli" },
      env({ HELPDORA_MODEL: "from-env" }),
    );
    expect(cfg.model).toBe("from-cli");
  });

  it("ignores malformed config file", () => {
    mkdirSync(join(tmp, "helpdora"), { recursive: true });
    writeFileSync(join(tmp, "helpdora", "config.json"), "not json");
    const cfg = loadConfig({}, env());
    expect(cfg.model).toBe("qwen3.5-9b");
  });

  it("rejects non-positive timeout", () => {
    const cfg = loadConfig({}, env({ HELPDORA_TIMEOUT_MS: "-1" }));
    expect(cfg.timeoutMs).toBe(120_000);
  });
});
