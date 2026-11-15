import { describe, expect, test } from "bun:test";

import { islandElementId } from "../../shared/island-id";
import { ArtifactEmitter } from "./artifact-emitter";

const HEAD_PAGE: string = "<!doctype html><html><head><title>orch</title></head><body></body></html>";

describe("ArtifactEmitter.islandMarkup", () => {
  test("writes a JSON data block under the shared island id", () => {
    const markup = ArtifactEmitter.islandMarkup("runs", { runs: [] });
    expect(markup).toBe(
      `<script type="application/json" id="${islandElementId("runs")}">{"runs":[]}</script>`,
    );
  });

  test("a value containing </script> cannot close the block early", () => {
    const markup = ArtifactEmitter.islandMarkup("runs", { text: "</script><img src=x>" });
    expect(markup).not.toContain("</script><img");
    // Exactly one closing tag: the element's own.
    expect(markup.split("</script>")).toHaveLength(2);
    expect(markup).toContain("\\u003c/script");
  });

  test("the escaped text still parses back to the original value", () => {
    const value = { text: "a < b </script> c", nested: ["<!--", "<div>"] };
    const markup = ArtifactEmitter.islandMarkup("runs", value);
    const json = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</script>"));
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe("ArtifactEmitter.spliceIslands", () => {
  test("inserts every island before </head>", () => {
    const spliced = ArtifactEmitter.spliceIslands(HEAD_PAGE, { runs: { runs: [] }, memory: {} });
    expect(spliced).not.toBeNull();
    const html = spliced ?? "";
    expect(html.indexOf(islandElementId("runs"))).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf(islandElementId("memory"))).toBeLessThan(html.indexOf("</head>"));
  });

  test("leaves the rest of the document untouched", () => {
    const html = ArtifactEmitter.spliceIslands(HEAD_PAGE, {}) ?? "";
    expect(html.replace(/\n/g, "")).toBe(HEAD_PAGE);
  });

  test("a page with no head is refused rather than silently mangled", () => {
    expect(ArtifactEmitter.spliceIslands("<html><body></body></html>", { runs: {} })).toBeNull();
  });
});
