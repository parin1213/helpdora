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
    expect(cacheClear(env)).toBe(2);
    expect(cacheList(env)).toEqual([]);
  });
});
