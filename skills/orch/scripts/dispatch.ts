#!/usr/bin/env bun
const argv = process.argv.slice(2);
// Fast path: help and no-argument usage need only the usage text, not every command module.
if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
  const { USAGE } = await import("../core/usage.ts");
  process.stdout.write(USAGE + "\n");
} else {
  const { main } = await import("../core/cli.ts");
  process.exitCode = await main(argv);
}
