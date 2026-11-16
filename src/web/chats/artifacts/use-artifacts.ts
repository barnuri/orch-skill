import { useCallback, useEffect, useRef, useState } from "react";
import { type ArtifactEvent, type ArtifactInfo, type ArtifactRef, mentionedNames, refBlock } from "../../../shared/artifacts";
import { authHeaders, eventsUrl } from "../../api/chats";
import { followSse } from "../../lib/sse";
import { artifactsApi } from "./api";

const AUTO_OPEN_KEY = "orch.artifacts.autoopen";
const PANEL_KEY = "orch.artifacts.open";

export interface ArtifactsState {
  chatId: string;
  items: ArtifactInfo[];
  dir: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  active: string | null;
  select: (name: string) => void;
  /** Content hash of each artifact as of the last event: a change reloads the panel. */
  hashes: Record<string, string>;
  refs: ArtifactRef[];
  addRef: (ref: ArtifactRef) => void;
  removeRef: (index: number) => void;
  /** The message text with the artifact references (chips and `@name` mentions) appended; the chips are cleared. */
  compose: (text: string) => string;
  autoOpen: boolean;
  setAutoOpen: (on: boolean) => void;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // private mode: the choice lasts until reload
  }
}

/**
 * The artifacts of one chat: the list, the panel's open state and the references waiting for the next message.
 * The list is kept live by the chat's event stream (`artifact` events: created, updated, deleted). The panel opens
 * by itself when the agent creates its first artifact in a turn, unless the user turned that off.
 */
export function useArtifacts(chatId: string): ArtifactsState {
  const [items, setItems] = useState<ArtifactInfo[]>([]);
  const [dir, setDir] = useState("artifacts");
  const [open, setOpenState] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<ArtifactRef[]>([]);
  const [autoOpen, setAutoOpenState] = useState(() => readFlag(AUTO_OPEN_KEY, true));
  const autoRef = useRef(autoOpen);
  autoRef.current = autoOpen;
  const itemsRef = useRef<ArtifactInfo[]>([]);
  itemsRef.current = items;
  const openedTurns = useRef(new Set<string>());
  const refsRef = useRef<ArtifactRef[]>([]);
  refsRef.current = refs;

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await artifactsApi.list(chatId);
      const list = Array.isArray(res.items) ? res.items : [];
      setItems(list);
      setDir(typeof res.dir === "string" ? res.dir : "artifacts");
      setHashes(Object.fromEntries(list.map((a) => [a.name, a.hash])));
      setActive((cur) => (cur !== null && list.some((a) => a.name === cur) ? cur : (list[0]?.name ?? null)));
    } catch {
      // no workspace yet: the list stays empty
    }
  }, [chatId]);

  useEffect(() => {
    setItems([]);
    setActive(null);
    setRefs([]);
    setOpenState(readFlag(`${PANEL_KEY}.${chatId}`, false));
    openedTurns.current = new Set();
    const abort = new AbortController();
    void reload();
    void followSse({
      url: eventsUrl(chatId),
      headers: authHeaders,
      resumeId: () => null,
      signal: abort.signal,
      onEvents: (events) => {
        let touched = false;
        for (const ev of events) {
          if (ev.event !== "artifact") {
            continue;
          }
          let data: ArtifactEvent;
          try {
            data = JSON.parse(ev.data) as ArtifactEvent;
          } catch {
            continue;
          }
          touched = true;
          setHashes((h) => ({ ...h, [data.name]: data.hash }));
          if (data.change === "created") {
            setActive((cur) => cur ?? data.name);
            const key = data.turn ?? "";
            if (autoRef.current && !openedTurns.current.has(key)) {
              openedTurns.current.add(key);
              setOpenState(true);
              setActive(data.name);
            }
          } else if (data.change === "deleted") {
            setItems((list) => list.filter((a) => a.name !== data.name));
          }
        }
        if (touched) {
          void reload();
        }
      },
    });
    return () => {
      abort.abort();
    };
  }, [chatId, reload]);

  const setOpen = useCallback(
    (on: boolean) => {
      setOpenState(on);
      writeFlag(`${PANEL_KEY}.${chatId}`, on);
    },
    [chatId],
  );
  const setAutoOpen = useCallback((on: boolean) => {
    setAutoOpenState(on);
    writeFlag(AUTO_OPEN_KEY, on);
  }, []);
  const addRef = useCallback((ref: ArtifactRef) => {
    setRefs((r) => [...r.filter((x) => !(x.name === ref.name && x.quote === ref.quote && x.version === ref.version)), ref]);
  }, []);
  const removeRef = useCallback((index: number) => {
    setRefs((r) => r.filter((_, i) => i !== index));
  }, []);
  const compose = useCallback(
    (text: string): string => {
      const chips = refsRef.current;
      const known = new Map(itemsRef.current.map((a) => [a.name, a]));
      const all = [...chips];
      for (const name of mentionedNames(text, [...known.keys()])) {
        const a = known.get(name);
        if (a !== undefined && !all.some((r) => r.name === name)) {
          all.push({ name, version: a.version, hash: a.hash });
        }
      }
      if (all.length === 0) {
        return text;
      }
      setRefs([]);
      return `${text}\n\n${refBlock(all, dir)}`;
    },
    [dir],
  );

  return { chatId, items, dir, open, setOpen, active, select: setActive, hashes, refs, addRef, removeRef, compose, autoOpen, setAutoOpen };
}
