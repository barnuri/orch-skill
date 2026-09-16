import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionChatReader } from "./session-chat-reader";

const SESSION: string = "503edded-727a-4e03-86df-3b7ba63f7d8f";
const OTHER_SESSION: string = "11111111-2222-3333-4444-555555555555";

const homes: string[] = [];

function claudeHomeWith(lines: readonly string[], session: string = SESSION): string {
  const home = mkdtempSync(join(tmpdir(), "orch-claude-"));
  homes.push(home);
  const project = join(home, "projects", "-Users-someone-repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${session}.jsonl`), `${lines.join("\n")}\n`);
  return home;
}

function userLine(text: string, uuid: string = "u1"): string {
  return JSON.stringify({
    uuid,
    type: "user",
    timestamp: "2026-09-15T12:00:00.000Z",
    message: { role: "user", content: text },
  });
}

function assistantLine(blocks: readonly unknown[], uuid: string = "a1"): string {
  return JSON.stringify({
    uuid,
    type: "assistant",
    timestamp: "2026-09-15T12:00:01.000Z",
    message: { role: "assistant", content: blocks },
  });
}

afterEach(() => {
  homes.splice(0);
});

describe("SessionChatReader.read", () => {
  test("reads a user turn and an assistant turn in transcript order", () => {
    const home = claudeHomeWith([
      userLine("do the thing"),
      assistantLine([{ type: "text", text: "done" }]),
    ]);
    const result = new SessionChatReader(home).read(SESSION);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.turns).toEqual([
      {
        id: "u1",
        role: "user",
        timestamp: "2026-09-15T12:00:00.000Z",
        text: "do the thing",
        tools: [],
      },
      {
        id: "a1",
        role: "assistant",
        timestamp: "2026-09-15T12:00:01.000Z",
        text: "done",
        tools: [],
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  test("a tool call is carried on its turn, summarised by its first string input", () => {
    const home = claudeHomeWith([
      assistantLine([
        { type: "text", text: "reading it" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x.ts" } },
      ]),
    ]);
    const result = new SessionChatReader(home).read(SESSION);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.turns[0]?.tools).toEqual([{ name: "Read", summary: "/tmp/x.ts" }]);
    expect(result.turns[0]?.text).toBe("reading it");
  });

  test("a long tool input is cut short rather than pasted whole", () => {
    const command = "x".repeat(400);
    const home = claudeHomeWith([
      assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: { command } }]),
    ]);
    const result = new SessionChatReader(home).read(SESSION);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    const summary = result.turns[0]?.tools[0]?.summary ?? "";
    expect(summary.length).toBeLessThan(command.length);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("thinking blocks stay private", () => {
    const home = claudeHomeWith([
      assistantLine([
        { type: "thinking", thinking: "secret reasoning", signature: "sig" },
        { type: "text", text: "the answer" },
      ]),
    ]);
    const result = new SessionChatReader(home).read(SESSION);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.text).toBe("the answer");
    expect(JSON.stringify(result.turns)).not.toContain("secret reasoning");
  });

  test("a line whose only content is a tool result is not a turn", () => {
    const home = claudeHomeWith([
      userLine("go"),
      JSON.stringify({
        uuid: "r1",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
        },
      }),
    ]);
    const result = new SessionChatReader(home).read(SESSION);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.turns.map((turn) => turn.id)).toEqual(["u1"]);
  });

  test("one malformed line does not lose the rest of the conversation", () => {
    const home = claudeHomeWith([userLine("first"), "{not json", assistantLine([{ type: "text", text: "second" }])]);
    const result = new SessionChatReader(home).read(SESSION);
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
  });

  test("a session with no transcript anywhere is missing", () => {
    const home = claudeHomeWith([userLine("x")]);
    expect(new SessionChatReader(home).read(OTHER_SESSION)).toEqual({ kind: "missing" });
  });

  test("a claude home with no projects directory is missing, not a crash", () => {
    const empty = mkdtempSync(join(tmpdir(), "orch-claude-empty-"));
    homes.push(empty);
    expect(new SessionChatReader(empty).read(SESSION)).toEqual({ kind: "missing" });
  });

  test("anything that is not a session id is refused before any path is built", () => {
    const home = claudeHomeWith([userLine("x")]);
    const reader = new SessionChatReader(home);
    for (const candidate of ["", "../../etc/passwd", "not-a-uuid", `${SESSION}/../x`]) {
      expect(reader.read(candidate)).toEqual({ kind: "invalid" });
    }
  });
});

describe("SessionChatReader.transcriptPath", () => {
  test("finds the transcript whichever project folder holds it", () => {
    const home = claudeHomeWith([userLine("x")]);
    mkdirSync(join(home, "projects", "-Users-someone-other"), { recursive: true });
    expect(new SessionChatReader(home).transcriptPath(SESSION)).toBe(
      join(home, "projects", "-Users-someone-repo", `${SESSION}.jsonl`),
    );
  });

  test("a traversal attempt never yields a path", () => {
    const home = claudeHomeWith([userLine("x")]);
    expect(new SessionChatReader(home).transcriptPath("../../../etc/passwd")).toBeNull();
  });
});
