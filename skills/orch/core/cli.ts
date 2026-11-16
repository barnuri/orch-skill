// orch CLI entry: argv parse, command table, exit codes. Bun built-ins only, no npm imports.
// Importing this module has no side effects; main() runs only when executed directly.

export const VERSION = "0.1.0";

export type Handler = (args: string[]) => Promise<number> | number;

// Ported `<group> <verb>` commands. Empty in phase 0: every command still runs bash.
export const COMMANDS: Record<string, Handler> = {};

export function parseArgv(argv: string[]): { flags: Set<string>; words: string[] } {
  const flags = new Set<string>();
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else words.push(a);
  }
  return { flags, words };
}

function usage(): string {
  return [
    "usage: orch --version | orch <group> <verb> [args...]",
    "ported commands: " + (Object.keys(COMMANDS).join(", ") || "(none)"),
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const { flags, words } = parseArgv(argv);
  if (flags.has("--version")) {
    process.stdout.write(`orch ${VERSION}\n`);
    return 0;
  }
  if (words.length === 0 || flags.has("--help") || flags.has("-h")) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  const key = `${words[0]} ${words[1] ?? ""}`.trim();
  const handler = COMMANDS[key];
  if (!handler) {
    process.stderr.write(`orch: unknown command '${key}'\n${usage()}\n`);
    return 2;
  }
  return await handler(words.slice(2));
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
