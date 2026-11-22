import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { digestToken } from "../http/auth";
import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { buildOptions, resolveLaunch } from "./options";
import { ChatService } from "./service";

const TEMPLATE = resolve(import.meta.dir, "../../../skills/orch/templates/profiles.json");
const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.ts");
const FAKE_LOAD = resolve(import.meta.dir, "testing/fake-dispatch-load.ts");
const HARNESSES = ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"];

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  for (const k of ["ORCH_CHAT_CLAUDE_BIN", "ORCH_CHAT_DISPATCH", "ORCH_CHAT_OPENCODE_DISPATCH", "LLM_HUB_URL", "LLM_HUB_KEY"]) {
    delete process.env[k];
  }
});

describe("every model chat-options offers is accepted on send", () => {
  test("all enabled profiles and models, through the real profile_load", async () => {
    const home = TempHome.create();
    home.write("profiles.json", (() => {
      const doc = JSON.parse(readFileSync(TEMPLATE, "utf8"));
      for (const spec of Object.values<any>(doc.profiles)) spec.usage = ["chat", "runs"];
      return JSON.stringify(doc);
    })());
    process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
    process.env.ORCH_CHAT_DISPATCH = FAKE_LOAD;
    process.env.ORCH_CHAT_OPENCODE_DISPATCH = "1";
    process.env.LLM_HUB_URL = "http://127.0.0.1:1";
    process.env.LLM_HUB_KEY = "k";
    const ctx: ServerContext = {
      paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
      requireRemoteToken: true, harnesses: HARNESSES, outcomes: [],
    };
    const service = new ChatService(ctx);
    cleanup.push(() => service.dispose());
    const jobs: (() => Promise<void>)[] = [];
    for (const harness of buildOptions(home.path, HARNESSES).harnesses) {
      for (const profile of harness.profiles.filter((p) => p.enabled)) {
        expect(profile.models.length, `${profile.name} offers no model`).toBeGreaterThan(0);
        for (const model of profile.models) {
          const launch = resolveLaunch(home.path, harness.id, profile.name, model.id);
          expect(launch.ok, `${profile.name}/${model.id}`).toBe(true);
          jobs.push(async () => {
            const chat = service.createChat({ harness: harness.id, profile: profile.name, model_id: model.id });
            service.sendMessage(chat.id, { content: "hi" });
            await service.settled(chat.id);
            const reply = service.store.listMessages(chat.id, {}).items.find((m) => m.role === "assistant");
            expect(reply?.error, `${profile.name}/${model.id}`).toBeNull();
            expect(reply?.status, `${profile.name}/${model.id}`).toBe("done");
            if (harness.id !== "claude") {
              expect(reply?.content).toBe(`slug=${model.slug} id=${model.id}`);
            }
          });
        }
      }
    }
    // Each send spawns a process, and start latency dominates, so the sends run in batches.
    const BATCH = 6;
    for (let i = 0; i < jobs.length; i += BATCH) {
      await Promise.all(jobs.slice(i, i + BATCH).map((job) => job()));
    }
    const checked = jobs.length;
    // The tracked template holds only the claude, cursor, copilot and opencode profiles; llm-hub and
    // local profiles live in the gitignored profiles.local.json overlay.
    expect(checked).toBeGreaterThan(5);
  }, 300000);
});
