import { useState } from "react";
import type { ProfileSpec } from "../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import "./pages.css";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { HarnessMark } from "../components/HarnessMark";
import { PageHead } from "../components/PageHead";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { Panel } from "../components/Panel";
import { Toggle } from "../components/Toggle";
import { useToast } from "../components/Toast";
import { DocNotices } from "../forms/DocNotices";
import { useDocEditor, useEscapeToClose } from "../forms/use-doc-editor";
import type { DocEditor } from "../forms/use-doc-editor";
import { useDocument } from "../api/queries";
import { asProfilesDocument } from "../lib/documents";
import { disabledHarnessSet, loadHideDisabled, offReason, saveHideDisabled, visibleProfiles } from "../lib/profile-filter";
import type { OffReason } from "../lib/profile-filter";
import { profileSwitchDecision } from "../lib/profile-switch";
import { fmtMs, statusOf } from "../lib/sanity-logic";
import { sanity } from "../lib/sanity-store";
import { UsageChips } from "../components/UsageChips";
import { profileUsage, type Use } from "../../shared/profile-usage";
import { USAGE_FILTERS, profileUseState, usageBadge, type UsageFilter } from "../lib/usage-ui";
import { useSetUsage } from "../lib/use-set-usage";
import { ProfileForm } from "./ProfileForm";
import { SanityPanel, SanityStatusChip, SanityTestButton, useRunSanity, useSanity } from "./SanityPanel";
import { SettingsForm } from "./SettingsForm";
import { NotificationsSection } from "../pwa/NotificationsSection";

const DESC_MAX = 48;
const CORRUPT_HINT = "profiles.json could not be parsed — fix it in an editor and this page picks it up.";

function Counts({ spec }: { spec: ProfileSpec }) {
  const flags = spec.flags?.length ?? 0;
  const env = Object.keys(spec.env ?? {}).length;
  const auth = spec.auth?.length ?? 0;
  return (
    <div className={flags + env + auth === 0 ? "counts mono muted" : "counts mono"} title={`${flags} flags · ${env} env · ${auth} auth`}>
      {`${flags}f ${env}e ${auth}a`}
    </div>
  );
}

function Description({ spec }: { spec: ProfileSpec }) {
  const text = spec.description ?? "";
  if (text === "") {
    return <div className="muted">no description</div>;
  }
  const truncated = text.length > DESC_MAX;
  return (
    <div className="desc-cell muted" title={truncated ? text : undefined}>
      {truncated ? `${text.slice(0, DESC_MAX)}…` : text}
    </div>
  );
}

export function routingText(spec: ProfileSpec, reason: OffReason | null): string {
  const parts: string[] = [];
  if (spec.min_complexity !== undefined || spec.max_complexity !== undefined) {
    parts.push(`${spec.min_complexity ?? "·"}→${spec.max_complexity ?? "·"}`);
  }
  if (spec.allowed_models !== undefined && spec.allowed_models.length > 0) {
    const [only] = spec.allowed_models;
    parts.push(spec.allowed_models.length === 1 && only !== undefined ? only : `${spec.allowed_models.length} models`);
  }
  if (spec.priority !== undefined) {
    parts.push(`p${spec.priority}`);
  }
  if (reason !== null) {
    parts.push("off");
  }
  return parts.join(" · ");
}

function SanityCell({ name, reason }: { name: string; reason: OffReason | null }) {
  const state = useSanity();
  const run = useRunSanity();
  const button = (label: string, alwaysVisible: boolean) => (
    <button
      className={alwaysVisible ? "sanity-run is-shown" : "sanity-run"}
      type="button"
      title={reason === "harness" ? `${name}'s harness is disabled` : reason !== null ? `${name} is disabled` : `Sanity test ${name}`}
      aria-label={`Sanity test ${name}`}
      disabled={reason !== null || state.running}
      onClick={(event) => {
        event.stopPropagation();
        run([name]);
      }}
    >
      {label}
    </button>
  );
  if (reason === null && sanity.pendingFor(name)) {
    return <div className="muted sanity-cell">testing…</div>;
  }
  const result = state.data?.results.find((r) => r.profile === name) ?? null;
  if (result === null) {
    return <div className="sanity-cell">{button("test", true)}</div>;
  }
  const status = statusOf(result);
  return (
    <div className="sanity-cell" title={result.error !== "" ? result.error : `exit ${result.exit_code} · ${result.bytes} B`}>
      <SanityStatusChip status={status} />
      {status === "ok" ? <span className="muted sanity-cell-ms">{fmtMs(result.ms)}</span> : null}
      {button("↻", false)}
    </div>
  );
}

type UsageDoc = Parameters<typeof profileUsage>[0];

function ProfileRow({ name, spec, doc, editor }: { name: string; spec: ProfileSpec; doc: ProfilesDocument; editor: DocEditor }) {
  const toast = useToast();
  const usage = useSetUsage("profile");
  const chatState = profileUseState(doc, name, "chat");
  const runsState = profileUseState(doc, name, "runs");
  const own = profileUsage(doc as unknown as UsageDoc, name);
  const badge = usageBadge(own);
  const reason = offReason(spec, disabledHarnessSet(doc));
  const selected = editor.target === name;
  const blocked = reason === "harness";
  const isEnabled = spec.enabled !== false && !blocked;
  const label = blocked ? `${name} cannot run: its ${spec.harness} harness is disabled` : isEnabled ? `Disable ${name}` : `Enable ${name}`;

  const toggleEditor = (): void => {
    // Clicking the open row closes the editor, but a dirty draft is never dropped on a stray click.
    if (selected) {
      if (!editor.dirty) {
        editor.cancel();
      }
      return;
    }
    editor.begin(name);
  };
  const flip = (): void => {
    const decision = profileSwitchDecision(doc, name, editor.dirty);
    if (decision.kind === "dirty") {
      toast("error", "Save or cancel your edits before changing a profile");
    } else if (decision.kind === "missing") {
      toast("error", `Profile ${name} is no longer available; reload the page`);
    } else {
      void editor.save(decision.document);
    }
  };
  const routing = routingText(spec, reason);
  const klass = `doc-row profile-row${selected ? " selected" : ""}${reason === null ? "" : " is-off"}`;
  return (
    // The row is a plain container holding a real per-profile action; the name button is the
    // keyboard and screen-reader path, a click elsewhere on the row is a mouse convenience.
    <div className={klass} role="row" onClick={toggleEditor}>
      <div className="title">
        <button
          className="profile-open"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleEditor();
          }}
        >
          {name}
          {doc.settings.default_profile === name ? <Chip status="default" /> : null}
        </button>
        {badge === null ? null : <Chip status="default">{badge}</Chip>}
        <UsageChips
          name={name}
          chat={{ on: chatState.on, lock: chatState.lock }}
          runs={{ on: runsState.on, lock: runsState.lock }}
          busy={usage.busy === name}
          lastOn={(use: Use) => own.length === 1 && own[0] === use}
          onChange={(use, on) => void usage.change(name, own, use, on)}
        />
      </div>
      <SanityCell name={name} reason={reason} />
      <div className="harness-cell">
        <HarnessMark id={spec.harness} size={14} />
        {reason === "harness" ? (
          <Chip status="waiting" title={`The ${spec.harness} harness is disabled`}>{`${spec.harness} off`}</Chip>
        ) : (
          <Chip status={spec.harness} />
        )}
      </div>
      {spec.cost !== undefined ? <Chip status={spec.cost} /> : <span />}
      {(spec.model ?? "") === "" ? <div className="muted">CLI default</div> : <div className="mono">{spec.model}</div>}
      {routing === "" ? <div className="muted">—</div> : <div className="mono muted">{routing}</div>}
      <Description spec={spec} />
      <Counts spec={spec} />
      <div className="switch-cell">
        <Toggle variant="switch" label={label} on={isEnabled} disabled={blocked} onChange={flip} />
      </div>
    </div>
  );
}

/** The `#/profiles` page: the profile rows on the left, settings or one profile on the right. */
export function ProfilesPage() {
  const query = useDocument("profiles");
  const editor = useDocEditor("profiles", query.data);
  useEscapeToClose(editor);
  const [hideDisabled, setHideDisabled] = useState(loadHideDisabled);
  const [useFilter, setUseFilter] = useState<UsageFilter>("all");
  const base = editor.base;
  const doc = base === null ? null : asProfilesDocument(base.document);
  const off = doc === null ? new Set<string>() : disabledHarnessSet(doc);
  const disabledCount = doc === null ? 0 : Object.values(doc.profiles).filter((spec) => offReason(spec, off) !== null).length;
  const count = doc === null ? 0 : Object.keys(doc.profiles).length;
  const fallback = doc?.settings.default_profile ?? "";
  const sub = base === null ? "Loading…" : doc === null ? "profiles.json could not be read." : `${count} ${count === 1 ? "profile" : "profiles"} · default ${fallback === "" ? "none" : fallback}`;

  const toolbar = (
    <>
      <div className="usage-filter" role="group" aria-label="Filter by use">
        {USAGE_FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={useFilter === f.id} onClick={() => { setUseFilter(f.id); }}>{f.label}</button>
        ))}
      </div>
      <Button
        aria-pressed={hideDisabled}
        onClick={() => {
          saveHideDisabled(!hideDisabled);
          setHideDisabled(!hideDisabled);
        }}
      >
        {hideDisabled ? `Show disabled (${disabledCount})` : `Hide disabled (${disabledCount})`}
      </Button>
      <SanityTestButton label="Sanity test all" />
    </>
  );

  if (base === null || doc === null) {
    return (
      <>
        <PageHead title="Profiles" subtitle={sub} toolbar={toolbar} />
        <DocNotices kind="profiles" editor={editor} />
        {base === null && query.error === null ? <Skeleton rows={5} /> : null}
        {base === null && query.error !== null ? <div className="notice" role="alert">{`Could not load profiles: ${query.error.message}`}</div> : null}
        {base !== null ? <div className="empty">{CORRUPT_HINT}</div> : null}
      </>
    );
  }
  const entries = visibleProfiles(doc.profiles, hideDisabled, off).filter(([name]) => useFilter === "all" || profileUseState(doc, name, useFilter).on);
  const target = editor.target;
  const editingProfile = typeof target === "string" && target !== "";
  return (
    <>
      <PageHead title="Profiles" subtitle={sub} toolbar={toolbar} />
      <DocNotices kind="profiles" editor={editor} />
      <div className="layout profile-layout">
        {entries.length === 0 ? (
          <EmptyState title={count === 0 ? "No profiles yet" : "No usable profiles"}>{count === 0 ? "Add one from the panel on the right." : "Every profile is disabled. Show disabled to see them all."}</EmptyState>
        ) : (
          <div className="runs">
            {entries.map(([name, spec]) => (
              <ProfileRow key={name} name={name} spec={spec} doc={doc} editor={editor} />
            ))}
          </div>
        )}
        {editingProfile ? (
          <Panel profile title={target === "new" ? "New profile" : target} onClose={editor.cancel}>
            <ProfileForm key={editor.session} doc={doc} target={target} enums={base.enums} editor={editor} />
          </Panel>
        ) : (
          <Panel title="Settings">
            <SettingsForm key={editor.session} doc={doc} editor={editor} />
            <NotificationsSection />
            <div className="actions">
              <Button
                onClick={() => {
                  editor.begin("new");
                }}
              >
                Add profile
              </Button>
            </div>
          </Panel>
        )}
      </div>
      <SanityPanel />
    </>
  );
}
