import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { copilotServedModel, isAutoSelector } from "./served-model";
import { installChatResumeCleanup, say, setup, store, TESTING } from "./testing/chat-resume-support";

installChatResumeCleanup();

const line = (type: string, data: object, at: string) => JSON.stringify({ type, data, timestamp: at });

describe("auto selectors", () => {
  test("names the hub and copilot auto selectors, not pinned models", () => {
    for (const id of ["hub-smart-auto-balance", "hub/smart-auto-balance", "copilot-auto", "cursor-auto", "auto"]) {
      expect(isAutoSelector(id)).toBe(true);
    }
    for (const id of ["copilot-opus-5.5", "hub-claude-opus-5-5", null, ""]) {
      expect(isAutoSelector(id)).toBe(false);
    }
  });
});

describe("copilotServedModel", () => {
  const since = Date.parse("2026-11-17T10:00:00Z");
  test("takes the newest assistant model of this turn and ignores older turns", () => {
    const log = [
      line("assistant.message", { model: "old-model" }, "2026-11-17T09:00:00Z"),
      line("session.model_change", { newModel: "auto" }, "2026-11-17T10:00:01Z"),
      line("assistant.message", { model: "claude-opus-5.5" }, "2026-11-17T10:00:02Z"),
    ].join("\n");
    expect(copilotServedModel(log, since)).toBe("claude-opus-5.5");
  });
  test("falls back to a model change away from auto", () => {
    const log = line("session.model_change", { newModel: "llama_swap/glm-4.7-flash", previousModel: "auto" }, "2026-11-17T10:00:02Z");
    expect(copilotServedModel(log, since)).toBe("llama_swap/glm-4.7-flash");
  });
  test("is null when the log names only auto, or nothing", () => {
    expect(copilotServedModel(line("session.model_change", { newModel: "auto" }, "2026-11-17T10:00:02Z"), since)).toBeNull();
    expect(copilotServedModel("not json\n", since)).toBeNull();
  });
});

describe("chat turns store the real model", () => {
  test("copilot auto: model_used is the model copilot's log names", async () => {
    const { service, home } = setup(join(TESTING, "fake-dispatch-copilot-auto.ts"));
    process.env.COPILOT_HOME = home.resolve("copilot");
    process.env.FAKE_COPILOT_SERVED = "claude-opus-5.5";
    try {
      const chat = service.createChat({ title: "t", harness: "copilot", profile: "copilot" });
      const m = await say(service, chat.id, "hi");
      expect(m.status).toBe("done");
      expect(m.model_used).toBe("claude-opus-5.5");
    } finally {
      delete process.env.COPILOT_HOME;
      delete process.env.FAKE_COPILOT_SERVED;
    }
  });

  test("copilot auto: model_used stays null when the log names no model", async () => {
    const { service, home } = setup(join(TESTING, "fake-dispatch-copilot-auto.ts"));
    process.env.COPILOT_HOME = home.resolve("copilot");
    try {
      const chat = service.createChat({ title: "t", harness: "copilot", profile: "copilot" });
      const m = await say(service, chat.id, "hi");
      expect(m.model_used).toBeNull();
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });

  test("hub smart auto: model_used is the model the hub recorded for the reply", async () => {
    const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ selected_effort: "high", selected_model: "claude-sonnet-x" }) });
    const { service } = setup(join(TESTING, "fake-dispatch.ts"));
    process.env.LLM_HUB_V1_URL = `http://127.0.0.1:${hub.port}/v1`;
    process.env.LLM_HUB_API_KEY = "k";
    try {
      const chat = service.createChat({ title: "t", harness: "local-llm", profile: "local-llm" });
      const m = await say(service, chat.id, "hi");
      expect(m.model_used).toBeNull();
      await (service as unknown as { recordHubSelection(c: string, m: string): Promise<void> }).recordHubSelection(chat.id, m.id);
      const row = store(service).getMessage(m.id);
      expect(row?.model_used).toBe("claude-sonnet-x");
      expect(row?.selected_model).toBe("claude-sonnet-x");
    } finally {
      delete process.env.LLM_HUB_V1_URL;
      delete process.env.LLM_HUB_API_KEY;
      hub.stop(true);
    }
  });
});
