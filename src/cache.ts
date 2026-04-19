import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(xdg, "dora");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Derive a stable cache key from any JSON-serialisable parts. Order matters,
 * so keep callers consistent. When `label` is given it is prepended to the
 * hash so `cache list` / `cache clear <pattern>` can recognise entries by
 * their mode+command (e.g. `summary--rg--a8b3c...`).
 */
export function cacheKey(parts: unknown[], label?: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(parts));
  const hash = h.digest("hex").slice(0, 20);
  if (!label) return hash;
  return `${slug(label)}--${hash}`;
}

/**
 * Filesystem-safe slug. Only alnum/dot/underscore/hyphen survive; everything
 * else becomes `_`. Collapses runs of `_` so cmds with unusual args stay
 * readable.
 */
function slug(s: string): string {
  return s
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

export interface CacheOptions {
  /** skip read; always write fresh */
  refresh?: boolean;
  /** disable both read and write */
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function cacheRead(key: string, opts: CacheOptions = {}): string | null {
  if (opts.disabled || opts.refresh) return null;
  const file = join(cacheDir(opts.env), key);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function cacheWrite(key: string, value: string, opts: CacheOptions = {}): void {
  if (opts.disabled) return;
  try {
    writeFileSync(join(cacheDir(opts.env), key), value, "utf8");
  } catch {
    /* best-effort */
  }
}

export interface CacheEntry {
  key: string;
  bytes: number;
  mtime: Date;
}

export function cacheList(env: NodeJS.ProcessEnv = process.env): CacheEntry[] {
  const dir = cacheDir(env);
  const out: CacheEntry[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    try {
      const s = statSync(f);
      if (s.isFile()) out.push({ key: name, bytes: s.size, mtime: s.mtime });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/**
 * Remove cache entries. With no pattern, clears everything. With a pattern,
 * removes only entries whose filename contains it as a substring (case-
 * sensitive). Good for iterative development: `cache clear rg` drops all
 * cached answers for the `rg` command across modes.
 */
export function cacheClear(pattern?: string, env: NodeJS.ProcessEnv = process.env): number {
  const dir = cacheDir(env);
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (pattern && !name.includes(pattern)) continue;
    try {
      unlinkSync(join(dir, name));
      n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}

export function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  return cacheDir(env);
}
