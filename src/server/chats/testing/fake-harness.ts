#!/usr/bin/env bun
// Test double for the opencode, cursor-agent and pi CLIs (copy or symlink it under that name).
// Keeps one file per session in $FAKE_STATE and answers "turns=<prompts seen in this session>".
// Never calls a model.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const name = basename(process.argv[1] ?? "");
const state = process.env.FAKE_STATE;
if (!state) {
  console.error("FAKE_STATE: parameter null or not set");
  process.exit(1);
}
mkdirSync(state, { recursive: true });
const argv = process.argv.slice(2);
const rand = () => Math.floor(Math.random() * 32768);
const stamp = () => Math.floor(Date.now() / 1000);

function reply(file: string, prompt: string): never {
  appendFileSync(file, `@@@\n${prompt}\n`);
  if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${name}\t${basename(file)}\t${prompt}\n`);
  const turns = readFileSync(file, "utf8").split("\n").filter((l) => l === "@@@").length;
  process.stdout.write(`turns=${turns}`);
  process.exit(0);
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
function flags(args: string[], spec: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const k = spec[args[i]!];
    if (k) o[k] = args[++i] ?? "";
  }
  return o;
}

if (name === "cursor-agent") {
  if (argv[0] === "create-chat") {
    if (process.env.FAKE_NO_CREATE_CHAT) process.exit(1);
    const id = `chat${stamp()}${rand()}`;
    writeFileSync(join(state, id), "");
    console.log(id);
    process.exit(0);
  }
  const f = flags(argv, { "-p": "prompt", "--resume": "resume" });
  const file = join(state, f.resume || `fresh${rand()}`);
  if (f.resume && !existsSync(file)) fail(`chat ${f.resume} not found`);
  reply(file, f.prompt ?? "");
} else if (name === "opencode") {
  if (argv[0] === "session") {
    if (process.env.FAKE_NO_SESSION_LIST) process.exit(1);
    const ids = readdirSync(state)
      .filter((n) => n.startsWith("ses_") && !n.endsWith(".title"))
      .sort((a, b) => statSync(join(state, b)).mtimeMs - statSync(join(state, a)).mtimeMs);
    const items = ids.map((id) => {
      const t = join(state, `${id}.title`);
      const title = existsSync(t) ? readFileSync(t, "utf8").split("\n")[0] : "";
      return `{"id":"${id}","title":"${title}"}`;
    });
    process.stdout.write(`[${items.join(",")}]\n`);
    process.exit(0);
  }
  const prompt = argv[1] ?? "";
  const f = flags(argv.slice(2), { "--session": "sid", "--title": "title" });
  let sid = f.sid ?? "";
  if (sid) {
    if (!existsSync(join(state, sid))) fail(`Session not found: ${sid}`);
  } else {
    sid = `ses_${stamp()}${rand()}`;
    writeFileSync(join(state, sid), "");
    writeFileSync(join(state, `${sid}.title`), `${f.title ?? ""}\n`);
  }
  reply(join(state, sid), prompt);
} else if (name === "pi") {
  const f = flags(argv, { "-p": "prompt", "--session-dir": "dir", "--session-id": "sid" });
  if (!f.sid) reply(join(state, `ephemeral${rand()}`), f.prompt ?? "");
  mkdirSync(f.dir ?? "", { recursive: true });
  reply(join(f.dir ?? "", f.sid), f.prompt ?? "");
}
