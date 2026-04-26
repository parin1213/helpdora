import { CommandNotFoundError } from "./help-fetcher.js";
import { isCommandAvailable } from "./command-exists.js";

export type Mode =
  | { kind: "help" }
  | { kind: "full"; cmd: string; args: string[] }
  | { kind: "summary"; cmd: string; args: string[] }
  | { kind: "intent"; cmd: string; args: string[]; intent: string }
  | { kind: "lookup"; intent: string };

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

/** A token "looks like" natural language if it has whitespace or any non-ASCII char. */
function looksLikePhrase(s: string): boolean {
  return /\s/.test(s) || /[^\x20-\x7e]/.test(s);
}

export type DetectOptions = {
  full?: boolean;
  prompt?: string;
  /** test seam: override PATH lookup */
  isCommandAvailable?: (name: string) => Promise<boolean>;
};

export async function detectMode(args: readonly string[], opts: DetectOptions): Promise<Mode> {
  if (opts.prompt && opts.full) {
    throw new ArgError("--full と -p は同時に指定できません");
  }

  if (opts.prompt) {
    if (args.length > 0) throw new ArgError("-p と位置引数は同時に指定できません");
    return { kind: "lookup", intent: opts.prompt };
  }

  if (opts.full) {
    if (args.length === 0) throw new ArgError("--full にはコマンド名が必要です");
    const [cmd, ...rest] = args;
    return { kind: "full", cmd: cmd!, args: rest };
  }

  if (args.length === 0) return { kind: "help" };

  const first = args[0]!;
  const check = opts.isCommandAvailable ?? isCommandAvailable;
  const available = await check(first);

  if (available) {
    const last = args[args.length - 1]!;
    if (args.length >= 2 && looksLikePhrase(last)) {
      return { kind: "intent", cmd: first, args: args.slice(1, -1), intent: last };
    }
    return { kind: "summary", cmd: first, args: args.slice(1) };
  }

  // first token is not a known command. If any arg has natural-language shape,
  // treat the whole input as a lookup query. Otherwise fail.
  if (args.some(looksLikePhrase)) {
    return { kind: "lookup", intent: args.join(" ") };
  }
  throw new CommandNotFoundError(first);
}
