import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "lm-studio" | "claude" | "codex";

export type Config = {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type ConfigOverrides = {
  provider?: Provider;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

const DEFAULTS: Config = {
  provider: "lm-studio",
  baseUrl: "http://localhost:1234/v1",
  apiKey: "lm-studio",
  model: "qwen3.5-9b",
  timeoutMs: 120_000,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "helpdora", "config.json");
}

export function loadConfig(cli: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const file = readConfigFile(configPath(env));
  const envCfg: Partial<Config> = {};
  if (env.HELPDORA_PROVIDER) {
    const p = env.HELPDORA_PROVIDER;
    if (p === "lm-studio" || p === "claude" || p === "codex") envCfg.provider = p;
  }
  if (env.HELPDORA_BASE_URL) envCfg.baseUrl = env.HELPDORA_BASE_URL;
  if (env.HELPDORA_API_KEY) envCfg.apiKey = env.HELPDORA_API_KEY;
  if (env.HELPDORA_MODEL) envCfg.model = env.HELPDORA_MODEL;
  if (env.HELPDORA_TIMEOUT_MS) {
    const n = Number(env.HELPDORA_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) envCfg.timeoutMs = n;
  }

  return {
    ...DEFAULTS,
    ...file,
    ...envCfg,
    ...cli,
  };
}

function readConfigFile(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Config> = {};
    if (typeof parsed.provider === "string") {
      const p = parsed.provider;
      if (p === "lm-studio" || p === "claude" || p === "codex") out.provider = p;
    }
    if (typeof parsed.baseUrl === "string") out.baseUrl = parsed.baseUrl;
    if (typeof parsed.apiKey === "string") out.apiKey = parsed.apiKey;
    if (typeof parsed.model === "string") out.model = parsed.model;
    if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0) {
      out.timeoutMs = parsed.timeoutMs;
    }
    return out;
  } catch {
    return {};
  }
}
