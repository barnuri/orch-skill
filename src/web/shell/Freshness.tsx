import { useEffect, useState } from "react";
import { DEAD_MS, FRESH_TICK_MS, STALE_MS } from "../lib/constants";
import { ago } from "../lib/format";
import { useConnection } from "./use-connection";

const OFFLINE_TEXT = "dashboard offline — CLI still works";
const WAITING_TEXT = "waiting for server…";

export function freshnessLevel(ageMs: number, lastError: string | null): "" | " stale" | " dead" {
  if (lastError !== null || ageMs > DEAD_MS) {
    return " dead";
  }
  return ageMs > STALE_MS ? " stale" : "";
}

/** Header dot + text, driven by the last successful GET (200 or 304), not by payload timestamps. */
export function Freshness() {
  const { lastOkAt, lastError } = useConnection();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, FRESH_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  let klass = "live dead";
  let text = lastError !== null ? OFFLINE_TEXT : WAITING_TEXT;
  if (lastOkAt !== null) {
    klass = `live${freshnessLevel(now - lastOkAt, lastError)}`;
    text = lastError !== null ? OFFLINE_TEXT : `Live · ${ago(lastOkAt)}`;
  }
  return (
    <div className={klass} id="fresh" aria-live="polite">
      <span className="dot" />
      <span className="live-text" id="fresh-text">
        {text}
      </span>
    </div>
  );
}
