import { test, expect } from "bun:test";
import { isChatModel, hubSlug, hubCatalogKey } from "../../core/commands/hub-models.ts";

test("embeddings, speech and video ids are not chat models", () => {
  expect(isChatModel("llmgw/azure/text-embedding-3-small")).toBe(false);
  expect(isChatModel("whisper/whisper-large-v3")).toBe(false);
  expect(isChatModel("llmgw/bedrock/twelvelabs.pegasus-1-5-v1:0")).toBe(false);
  expect(isChatModel("copilot/claude-opus-5-5[1m]")).toBe(true);
});

test("slug keeps an existing hub/ prefix and adds one otherwise", () => {
  expect(hubSlug("hub/smart-auto-balance")).toBe("hub/smart-auto-balance");
  expect(hubSlug("copilot/claude-opus-5-5[1m]")).toBe("hub/copilot/claude-opus-5-5[1m]");
});

test("catalog key is hub- plus the slug without its prefix, with unsafe characters replaced", () => {
  expect(hubCatalogKey("hub/smart-auto-balance")).toBe("hub-smart-auto-balance");
  expect(hubCatalogKey("hub/copilot/claude-opus-5-5[1m]")).toBe("hub-copilot-claude-opus-5-5-1m");
});
