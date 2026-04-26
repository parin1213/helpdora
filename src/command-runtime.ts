import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  out: string;
};

export type PowerShellCommandInfo = {
  name: string;
  commandType: string;
  definition?: string;
};

export function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, LANG: "C", LC_ALL: "C", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (buffer: Buffer) => chunks.push(buffer));
    child.stderr.on("data", (buffer: Buffer) => chunks.push(buffer));

    const killer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", () => {
      clearTimeout(killer);
      resolve({ code: 1, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, out: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

export async function runPowerShell(command: string, timeoutMs: number): Promise<RunResult> {
  return runCmd(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    timeoutMs,
    { TERM: "dumb" },
  );
}

export async function resolvePowerShellCommand(
  name: string,
  timeoutMs: number,
): Promise<PowerShellCommandInfo | null> {
  if (process.platform !== "win32") return null;

  const script = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$cmd = Get-Command -Name ${powerShellQuote(name)} -ErrorAction SilentlyContinue | Select-Object -First 1 Name,CommandType,Definition`,
    "if ($cmd) { $cmd | ConvertTo-Json -Compress }",
  ].join("; ");

  const result = await runPowerShell(script, timeoutMs);
  const payload = result.out.trim();
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as {
      Name?: unknown;
      CommandType?: unknown;
      Definition?: unknown;
    };

    return {
      name: typeof parsed.Name === "string" ? parsed.Name : name,
      commandType: typeof parsed.CommandType === "string" ? parsed.CommandType : "",
      definition: typeof parsed.Definition === "string" ? parsed.Definition : undefined,
    };
  } catch {
    return null;
  }
}
