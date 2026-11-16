import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CHAT_ROOTS_DEFAULT, SCHEDULE_GRACE_DEFAULT_HOURS } from "../../shared/chat-settings";
import type { ProfilesSettings } from "../../shared/types/profiles-settings";
import { api } from "../api/client";
import { chatSettingsApi } from "../api/chat-settings";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { Field } from "../forms/Field";
import "./chat-settings.css";

export interface ChatDraft {
  /** Empty means not set: the default applies. */
  graceHours: string;
  allowLinkLocal: boolean;
  /** One folder per line; empty means the default root. */
  roots: string;
}

export interface ChatDraftErrors {
  graceHours?: string;
  roots?: string;
}

export function chatDraftFrom(settings: ProfilesSettings): ChatDraft {
  return {
    graceHours: settings.schedule_grace_hours === undefined ? "" : String(settings.schedule_grace_hours),
    allowLinkLocal: settings.monitor_allow_link_local === true,
    roots: (settings.chat_roots ?? []).join("\n"),
  };
}

/** Writes the draft into the settings: a box left empty leaves its key out, so the default applies. */
export function applyChatDraft(settings: ProfilesSettings, draft: ChatDraft, roots: readonly string[]): void {
  const grace = draft.graceHours.trim();
  if (grace === "") {
    delete settings.schedule_grace_hours;
  } else {
    settings.schedule_grace_hours = Number(grace);
  }
  if (draft.allowLinkLocal) {
    settings.monitor_allow_link_local = true;
  } else {
    delete settings.monitor_allow_link_local;
  }
  if (roots.length === 0) {
    delete settings.chat_roots;
  } else {
    settings.chat_roots = [...roots];
  }
}

/**
 * The Chat section of the Settings page: the schedule grace, link-local monitors, the folders a chat may use and the
 * secure-link hint. The first three are part of the profiles document (saved with the form's Save); the hint lives in
 * serve.json and is saved the moment it is switched.
 */
export function ChatSettingsFields({ draft, errors, onChange }: { draft: ChatDraft; errors: ChatDraftErrors; onChange: (next: ChatDraft) => void }) {
  const warnId = useId();
  return (
    <section className="chat-settings" aria-labelledby="chat-settings-h" data-testid="chat-settings">
      <h3 id="chat-settings-h">Chat</h3>
      <Field label="Missed schedule grace (hours)" path="settings.schedule_grace_hours" hint={`How late a missed schedule may still run after the server was off. Empty means ${SCHEDULE_GRACE_DEFAULT_HOURS}. 0 skips every missed run.`}>
        {({ id, invalid }) => (
          <>
            <input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder={String(SCHEDULE_GRACE_DEFAULT_HOURS)}
              aria-invalid={invalid || errors.graceHours !== undefined || undefined}
              value={draft.graceHours}
              onChange={(event) => { onChange({ ...draft, graceHours: event.target.value }); }}
            />
            {errors.graceHours === undefined ? null : <div className="field-error" role="alert" data-testid="grace-error">{errors.graceHours}</div>}
          </>
        )}
      </Field>
      <div className="field" data-path="settings.monitor_allow_link_local">
        <label className="chat-switch">
          <input
            type="checkbox"
            checked={draft.allowLinkLocal}
            aria-describedby={warnId}
            data-testid="link-local"
            onChange={(event) => { onChange({ ...draft, allowLinkLocal: event.target.checked }); }}
          />
          <span>Let chat monitors check link-local addresses</span>
        </label>
        <div className="hint is-warn" id={warnId}>Off by default: link-local addresses (169.254.x.x) include cloud metadata endpoints that can expose credentials.</div>
      </div>
      <Field label="Chat folders" path="settings.chat_roots" hint={`Folders a chat may run in, one per line (absolute, or starting with ~/). Empty means ${CHAT_ROOTS_DEFAULT.join(", ")}.`}>
        {({ id, invalid }) => (
          <>
            <textarea
              id={id}
              className="chat-roots"
              dir="ltr"
              rows={3}
              spellCheck={false}
              placeholder={CHAT_ROOTS_DEFAULT.join("\n")}
              aria-invalid={invalid || errors.roots !== undefined || undefined}
              value={draft.roots}
              onChange={(event) => { onChange({ ...draft, roots: event.target.value }); }}
            />
            {errors.roots === undefined ? null : <div className="field-error" role="alert" data-testid="roots-error">{errors.roots}</div>}
          </>
        )}
      </Field>
      <SecureLinkSwitch />
    </section>
  );
}

function SecureLinkSwitch() {
  const toast = useToast();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const info = useQuery({
    queryKey: ["server-info"],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await api.getServerInfo();
      return r.kind === "ok" ? r.body : null;
    },
  });
  const on = info.data?.secure_link_hint !== false;
  const change = async (next: boolean): Promise<void> => {
    setBusy(true);
    const res = await chatSettingsApi.setSecureLinkHint(next);
    setBusy(false);
    if (res.kind === "ok") {
      await client.invalidateQueries({ queryKey: ["server-info"] });
    } else {
      toast("error", describeFailure(res, "could not save the secure-link hint"));
    }
  };
  return (
    <div className="field" data-path="secure_link_hint">
      <label className="chat-switch">
        <input type="checkbox" checked={on} disabled={busy || info.data === undefined} data-testid="secure-link-hint" onChange={(event) => { void change(event.target.checked); }} />
        <span>Show the secure-link hint</span>
      </label>
      <div className="hint">A quiet note that offers the https address when voice or notifications need it. Saved as soon as you switch it.</div>
    </div>
  );
}
