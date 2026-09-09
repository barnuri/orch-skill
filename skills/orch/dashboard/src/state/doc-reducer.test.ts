import { describe, expect, test } from "bun:test";

import type { LoadedDocument } from "./loaded-document";
import { applyDocLoad } from "./doc-reducer.ts";

function doc(etag: string): LoadedDocument {
  return {
    kind: "profiles",
    document: { settings: {}, models: {}, profiles: {} },
    etag,
    enums: ["claude"],
    issues: [],
    maxBodyBytes: 1024,
  };
}

describe("applyDocLoad", () => {
  test("the first load is adopted and rendered", () => {
    const next = doc("e1");
    expect(applyDocLoad({ doc: null, dirty: false }, next)).toEqual({
      doc: next,
      drift: false,
      rerender: true,
    });
  });

  // Even a dirty editor takes the first document — there is nothing to protect yet.
  test("the first load is adopted even when the slice is marked dirty", () => {
    const next = doc("e1");
    expect(applyDocLoad({ doc: null, dirty: true }, next).doc).toBe(next);
  });

  // The 2 s poll must never rebuild a form the user is typing in.
  test("an unchanged etag keeps the existing document and skips the rerender", () => {
    const prev = doc("e1");
    expect(applyDocLoad({ doc: prev, dirty: false }, doc("e1"))).toEqual({
      doc: prev,
      drift: false,
      rerender: false,
    });
  });

  test("an unchanged etag never flags drift, dirty or not", () => {
    const prev = doc("e1");
    expect(applyDocLoad({ doc: prev, dirty: true }, doc("e1"))).toEqual({
      doc: prev,
      drift: false,
      rerender: false,
    });
  });

  // Someone else saved while the user had edits: keep the edits, show the drift notice.
  test("a new etag while dirty keeps the user's document and flags drift", () => {
    const prev = doc("e1");
    expect(applyDocLoad({ doc: prev, dirty: true }, doc("e2"))).toEqual({
      doc: prev,
      drift: true,
      rerender: false,
    });
  });

  test("a new etag while clean is adopted and rebuilt", () => {
    const next = doc("e2");
    expect(applyDocLoad({ doc: doc("e1"), dirty: false }, next)).toEqual({
      doc: next,
      drift: false,
      rerender: true,
    });
  });

  test("drift and rerender are never both true", () => {
    const outcome = applyDocLoad({ doc: doc("e1"), dirty: true }, doc("e2"));
    expect(outcome.drift && outcome.rerender).toBe(false);
  });
});
