import { useState } from "react";
import "./pages.css";
import { Skeleton } from "../components/Skeleton";
import { HarnessMark } from "../components/HarnessMark";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { PageHead } from "../components/PageHead";
import { useToast } from "../components/Toast";
import { describeFailure } from "../api/result";
import type { HarnessStatus } from "../../shared/types/harness-status";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import { useDocEditor } from "../forms/use-doc-editor";
import { ApiFailure, forceNextHarnessProbe, keys, queryClient, useDocument, useHarnesses } from "../api/queries";
import { asProfilesDocument } from "../lib/documents";
import { UsageChips } from "../components/UsageChips";
import { harnessUsage, type Use } from "../../shared/profile-usage";
import { USAGE_FILTERS, usageBadge, type UsageFilter } from "../lib/usage-ui";
import { useSetUsage } from "../lib/use-set-usage";

function StatusChip({ harness }: { harness: HarnessStatus }) {
  if (!harness.wired) {
    return <Chip status={harness.available ? "done" : "waiting"}>{harness.available ? "detected" : "missing"}</Chip>;
  }
  if (!harness.enabled) {
    return <Chip status="default">disabled</Chip>;
  }
  // The `done` class carries the green dot; a harness is "ready", not "done".
  return harness.available ? <Chip status="done">ready</Chip> : <Chip status="waiting">missing</Chip>;
}

/** The probe's list with `enabled` taken from the saved settings, so a toggle shows at once instead of after the next (slow) probe. */
export function withSavedEnabled(list: readonly HarnessStatus[], doc: ProfilesDocument | null): HarnessStatus[] {
  if (doc === null) {
    return [...list];
  }
  const disabled = new Set(doc.settings.disabled_harnesses ?? []);
  const saved = (doc.settings.harness_usage ?? {}) as Record<string, Use[]>;
  return list.map((h) => {
    if (!h.wired) {
      return h;
    }
    const usage = harnessUsage({ settings: { harness_usage: saved } }, h.id);
    return { ...h, enabled: !disabled.has(h.id), usage };
  });
}

/** The document with `id` added to or dropped from settings.disabled_harnesses, keys sorted. */
export function withHarnessEnabled(loaded: ProfilesDocument, id: string, enabled: boolean): ProfilesDocument {
  const next = structuredClone(loaded);
  const disabled = new Set(next.settings.disabled_harnesses ?? []);
  if (enabled) {
    disabled.delete(id);
  } else {
    disabled.add(id);
  }
  if (disabled.size === 0) {
    delete next.settings.disabled_harnesses;
  } else {
    next.settings.disabled_harnesses = [...disabled].sort((a, b) => a.localeCompare(b));
  }
  return next;
}

function HarnessCard({
  harness,
  busy,
  onToggle,
  usageBusy,
  onUsage,
}: {
  harness: HarnessStatus;
  busy: boolean;
  onToggle: ((enabled: boolean) => void) | null;
  usageBusy: boolean;
  onUsage: ((use: Use, on: boolean) => void) | null;
}) {
  const uses: Use[] = harness.usage ?? ["chat", "runs"];
  const badge = usageBadge(uses);
  const ready = harness.wired && harness.enabled && harness.available;
  return (
    <article className={ready ? "harness-card is-ready" : "harness-card"}>
      <div className="harness-head">
        <span className="harness-logo">
          <HarnessMark id={harness.id} size={18} />
        </span>
        <h3 className="harness-title mono">{harness.id}</h3>
        <StatusChip harness={harness} />
        <span className="muted">{harness.kind}</span>
        {harness.wired ? null : <span className="muted">not wired</span>}
        {badge === null || !harness.wired ? null : <Chip status="default">{badge}</Chip>}
      </div>
      <p className="harness-desc">{harness.description}</p>
      {harness.binary === null ? null : <p className="hint mono">{`binary: ${harness.binary}`}</p>}
      {harness.needs.length > 0 ? <p className="hint">{`needs: ${harness.needs.join(", ")}`}</p> : null}
      {!harness.available && harness.reason !== "" ? <p className="harness-reason">{harness.reason}</p> : null}
      {harness.wired && onUsage !== null ? (
        <UsageChips
          name={harness.id}
          chat={{ on: uses.includes("chat"), lock: null }}
          runs={{ on: uses.includes("runs"), lock: null }}
          busy={usageBusy}
          lastOn={(use) => uses.length === 1 && uses[0] === use}
          onChange={onUsage}
        />
      ) : null}
      {harness.wired && onToggle !== null ? (
        <div className="harness-actions">
          <Button
            disabled={busy}
            onClick={() => {
              onToggle(!harness.enabled);
            }}
          >
            {harness.enabled ? "Disable in UI" : "Enable in UI"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** The `#/harnesses` page: probed adapters and other detected agent CLIs on this machine. */
export function HarnessesPage() {
  const toast = useToast();
  const profiles = useDocument("profiles");
  const harnesses = useHarnesses();
  const editor = useDocEditor("profiles", profiles.data);
  const [busy, setBusy] = useState<string | null>(null);
  const usage = useSetUsage("harness");
  const [useFilter, setUseFilter] = useState<UsageFilter>("all");
  const loaded = asProfilesDocument(editor.base?.document);
  const probed = harnesses.data?.harnesses ?? null;
  const list = probed === null ? null : withSavedEnabled(probed, loaded);
  const failure = harnesses.error instanceof ApiFailure ? describeFailure(harnesses.error.result, "harness probe failed") : harnesses.error === null ? null : "harness probe failed";

  const wired = list?.filter((h) => h.wired).length ?? 0;
  const detected = list?.filter((h) => !h.wired && h.available).length ?? 0;
  const sub = list === null ? "Probing this machine…" : `${wired} orch adapters · ${detected} other CLI${detected === 1 ? "" : "s"} detected`;

  const redetect = (): void => {
    forceNextHarnessProbe();
    void queryClient.invalidateQueries({ queryKey: [keys.harnesses] });
  };
  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    if (loaded === null) {
      return;
    }
    setBusy(id);
    const saved = await editor.save(withHarnessEnabled(loaded, id, enabled));
    if (!saved && editor.docError === null) {
      toast("error", `Could not update ${id}`);
    }
    setBusy(null);
  };

  const refreshButton = (
    <>
      <div className="usage-filter" role="group" aria-label="Filter by use">
        {USAGE_FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={useFilter === f.id} onClick={() => { setUseFilter(f.id); }}>{f.label}</button>
        ))}
      </div>
      <Button onClick={redetect}>Re-detect</Button>
    </>
  );
  if (failure !== null && list === null) {
    return (
      <>
        <PageHead title="Harnesses" subtitle={sub} toolbar={refreshButton} />
        <div className="notice">{failure}</div>
      </>
    );
  }
  if (list === null) {
    return (
      <>
        <PageHead title="Harnesses" subtitle={sub} toolbar={refreshButton} />
        <Skeleton rows={4} />
      </>
    );
  }
  const extra = list.filter((h) => !h.wired);
  const toggler = (id: string) => (loaded === null ? null : (enabled: boolean) => void toggle(id, enabled));
  return (
    <>
      <PageHead title="Harnesses" subtitle={sub} toolbar={refreshButton} />
      <p className="sub harness-intro">
        Wired adapters can be used in profiles. Other CLIs are auto-detected for visibility — orch does not dispatch to them yet.
      </p>
      <section className="harness-section">
        <h2>Orch adapters</h2>
        <div className="harness-grid">
          {list
            .filter((h) => h.wired && (useFilter === "all" || (h.usage ?? ["chat", "runs"]).includes(useFilter)))
            .map((harness) => (
              <HarnessCard
                key={harness.id}
                harness={harness}
                busy={busy === harness.id || editor.saving}
                onToggle={toggler(harness.id)}
                usageBusy={usage.busy === harness.id}
                onUsage={(use, on) => void usage.change(harness.id, harness.usage ?? ["chat", "runs"], use, on)}
              />
            ))}
        </div>
      </section>
      {extra.length > 0 ? (
        <section className="harness-section">
          <h2>Detected CLIs</h2>
          <div className="harness-grid">
            {extra.map((harness) => (
              <HarnessCard key={harness.id} harness={harness} busy={false} onToggle={null} usageBusy={false} onUsage={null} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
