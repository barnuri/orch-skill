import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { MANUAL_START_COMMAND, RESTART_COMMAND } from "../../shared/build-commands";
import type { BuildInfo } from "../../shared/types/build-info";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { Button } from "../components/Button";
import { useConfirm } from "../components/ConfirmDialog";
import { fetchBuild, useBuild } from "./use-build";

export const RESTART_POLL_MS = 1000;
export const RESTART_TIMEOUT_MS = 60_000;

type Restart = { phase: "idle" } | { phase: "restarting" } | { phase: "failed"; message: string; command: string };

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function confirmBody(busy: BuildInfo["busy"]): string {
  const parts = ["This restarts the dashboard service so it runs the latest code. The page reloads when the server is back."];
  if (busy.chats_streaming > 0) {
    parts.push(`${plural(busy.chats_streaming, "chat reply is", "chat replies are")} streaming now and will be cut. Chat history is kept.`);
  } else {
    parts.push("No chat reply is streaming now. Chat history is kept.");
  }
  parts.push(
    busy.runs_running > 0
      ? `${plural(busy.runs_running, "orch node is", "orch nodes are")} running; they are not affected, because agents run outside the server.`
      : "Running orch nodes are not affected, because agents run outside the server.",
  );
  return parts.join(" ");
}

interface Props {
  restartPollMs?: number;
  restartTimeoutMs?: number;
  reload?: () => void;
}

/** Top-bar pill that appears only when the running server lacks the code on disk; the panel lists what is missing and offers a restart. */
export function BuildBanner({ restartPollMs = RESTART_POLL_MS, restartTimeoutMs = RESTART_TIMEOUT_MS, reload = () => location.reload() }: Props) {
  const build = useBuild();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [restart, setRestart] = useState<Restart>({ phase: "idle" });
  const pill = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    pill.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, confirming, close]);

  const data = build.data;
  const bootAt = data?.boot_at ?? null;

  const waitForNewBoot = useCallback(
    async (previous: string | null) => {
      const deadline = Date.now() + restartTimeoutMs;
      while (alive.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, restartPollMs));
        const left = deadline - Date.now();
        const next = await Promise.race([
          fetchBuild().catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(left, 0))),
        ]);
        if (next !== null && next.boot_at !== previous) {
          reload();
          return;
        }
      }
      if (alive.current) {
        setRestart({ phase: "failed", message: `The server did not come back within ${Math.round(restartTimeoutMs / 1000)} s.`, command: RESTART_COMMAND });
      }
    },
    [reload, restartPollMs, restartTimeoutMs],
  );

  const onRestart = async () => {
    if (data === undefined) {
      return;
    }
    setConfirming(true);
    const yes = await confirm({
      title: "Restart the dashboard server?",
      body: confirmBody(data.busy),
      confirmLabel: "Restart and update",
      danger: true,
    });
    setConfirming(false);
    if (!yes) {
      return;
    }
    setRestart({ phase: "restarting" });
    const result = await api.requestRestart();
    if (result.kind !== "ok") {
      const notInstalled = result.kind === "error" && result.body?.error === "service not installed";
      setRestart({
        phase: "failed",
        message: describeFailure(result, "Restart failed"),
        command: notInstalled ? MANUAL_START_COMMAND : RESTART_COMMAND,
      });
      return;
    }
    await waitForNewBoot(bootAt);
  };

  const copy = () => {
    void navigator.clipboard.writeText(RESTART_COMMAND).then(
      () => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      },
      () => undefined,
    );
  };

  let body: React.ReactNode = null;
  if (restart.phase === "restarting") {
    body = (
      <span className="build-pill restarting" id="build-pill">
        <span className="build-spin" aria-hidden="true" />
        Restarting…
      </span>
    );
  } else if (data?.stale === true) {
    body = (
      <button
        ref={pill}
        type="button"
        className="build-pill"
        id="build-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span aria-hidden="true">▲</span> Server out of date
      </button>
    );
  } else if (build.isError || data?.error != null) {
    body = (
      <span className="build-unavail" role="img" aria-label="Build check unavailable" title={`Build check unavailable${data?.error != null ? `: ${data.error}` : ""}`}>
        ⓘ
      </span>
    );
  }

  const show = open && data?.stale === true && restart.phase !== "restarting";
  return (
    <div className="build-slot" aria-live="polite">
      {body}
      {show
        ? createPortal(
        <>
          <div
            className="build-backdrop"
            onClick={() => {
              if (!confirming) {
                close();
              }
            }}
          />
          <div ref={panel} className="build-panel" role="dialog" aria-label="Server out of date" tabIndex={-1}>
            <h2>Server out of date</h2>
            <p className="build-note">
              The running server started {when(data.boot_at)} and does not include everything on disk.
            </p>
            {data.missing_total > 0 ? (
              <section>
                <h3>{plural(data.missing_total, "commit", "commits")} not running</h3>
                <ul className="build-list">
                  {data.missing_commits.map((c) => (
                    <li key={c.sha}>
                      <code>{c.sha.slice(0, 7)}</code> {c.subject} <span className="build-date">{when(c.date)}</span>
                    </li>
                  ))}
                </ul>
                {data.missing_total > data.missing_commits.length ? (
                  <p className="build-note">…and {data.missing_total - data.missing_commits.length} more</p>
                ) : null}
              </section>
            ) : null}
            {data.changed_files.count > 0 ? (
              <section>
                <h3>{plural(data.changed_files.count, "file", "files")} changed since start</h3>
                <ul className="build-list">
                  {data.changed_files.newest.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <p className="build-note">Uncommitted changes in the checkout: {data.uncommitted.count}</p>
            {restart.phase === "failed" ? (
              <p className="build-error" role="alert">
                {restart.message} Run <code>{restart.command}</code> by hand.
              </p>
            ) : null}
            <div className="build-actions">
              <Button variant="primary" onClick={() => void onRestart()}>
                Restart and update
              </Button>
              <button type="button" className="build-link" onClick={copy}>
                {copied ? "Copied" : "Copy command"}
              </button>
            </div>
            <code className="build-cmd">{RESTART_COMMAND}</code>
          </div>
        </>,
        document.body,
      )
        : null}
    </div>
  );
}
