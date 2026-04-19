import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, cacheRead, cacheWrite, cacheList, cacheClear } from "../src/cache.js";

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dora-cache-"));
  env = { XDG_CACHE_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("cache", () => {
  it("cacheKey is stable for equal inputs", () => {
    expect(cacheKey(["a", 1, { x: 2 }])).toBe(cacheKey(["a", 1, { x: 2 }]));
  });

  it("cacheKey differs when any part changes", () => {
    const a = cacheKey(["a", 1]);
    const b = cacheKey(["a", 2]);
    expect(a).not.toBe(b);
  });

  it("write + read round-trips", () => {
    const k = cacheKey(["test"]);
    cacheWrite(k, "hello cache", { env });
    expect(cacheRead(k, { env })).toBe("hello cache");
  });

  it("refresh bypasses read", () => {
    const k = cacheKey(["test"]);
    cacheWrite(k, "v1", { env });
    expect(cacheRead(k, { env, refresh: true })).toBeNull();
    expect(cacheRead(k, { env })).toBe("v1");
  });

  it("disabled skips both read and write", () => {
    const k = cacheKey(["test"]);
    cacheWrite(k, "v1", { env, disabled: true });
    expect(cacheRead(k, { env })).toBeNull();
  });

  it("cacheList returns entries sorted newest-first", async () => {
    cacheWrite("a", "1", { env });
    await new Promise((r) => setTimeout(r, 10));
    cacheWrite("b", "1", { env });
    const entries = cacheList(env);
    expect(entries[0]?.key).toBe("b");
    expect(entries[1]?.key).toBe("a");
  });

  it("cacheClear removes all entries", () => {
    cacheWrite("a", "1", { env });
    cacheWrite("b", "2", { env });
    expect(cacheClear(undefined, env)).toBe(2);
    expect(cacheList(env)).toEqual([]);
  });

  it("cacheClear with pattern only removes matching entries", () => {
    cacheWrite("summary--rg--abc", "1", { env });
    cacheWrite("summary--git--def", "1", { env });
    cacheWrite("full--rg--ghi", "1", { env });
    expect(cacheClear("rg", env)).toBe(2);
    const remaining = cacheList(env).map((e) => e.key).sort();
    expect(remaining).toEqual(["summary--git--def"]);
  });

  it("cacheKey with label prefixes the hash", () => {
    const k = cacheKey(["x"], "summary--rg");
    expect(k).toMatch(/^summary--rg--[0-9a-f]{20}$/);
  });

  it("cacheKey sanitises unsafe chars in the label", () => {
    const k = cacheKey(["x"], "intent--git commit/foo");
    expect(k).toMatch(/^intent--git_commit_foo--[0-9a-f]{20}$/);
  });
});
