import type { LoadedDocument } from "./loaded-document";

type DocLoadPrev = { doc: LoadedDocument | null; dirty: boolean };
type DocLoadOutcome = { doc: LoadedDocument; drift: boolean; rerender: boolean };

// Pure: decides what a fresh GET /api/<kind> result does to the editor slice.
// - same etag → nothing (the 2 s poll must never rebuild a form the user is typing in)
// - new etag while dirty → keep the user's document, flag drift (only the notice re-renders)
// - new etag while clean → adopt it and rebuild
export function applyDocLoad(prev: DocLoadPrev, next: LoadedDocument): DocLoadOutcome {
  if (prev.doc === null) {
    return { doc: next, drift: false, rerender: true };
  }
  if (prev.doc.etag === next.etag) {
    return { doc: prev.doc, drift: false, rerender: false };
  }
  if (prev.dirty) {
    return { doc: prev.doc, drift: true, rerender: false };
  }
  return { doc: next, drift: false, rerender: true };
}
