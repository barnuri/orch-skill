import {
  harnessProblem,
  harnessUsable,
  modelLabel,
  profileProblem,
  profileUsable,
  resolvePickers,
} from "../lib/chat-logic";
import type { Selection } from "../lib/chat-logic";
import { memoryNote } from "../lib/chat-logic";
import type { Chat, ChatOptions } from "../lib/chat-types";
import { PickerSelect } from "./PickerSelect";
import type { PickerOption } from "./PickerSelect";

interface PickersProps {
  options: ChatOptions;
  /** What the picker shows and edits. */
  selection: Selection;
  onChange: (next: Selection) => void;
  /** A reply is running: values cannot change until it ends. */
  locked: boolean;
  /** Model the last reply actually used. */
  modelUsed: string | null;
}

function withCurrent(list: PickerOption[], value: string, label: string): PickerOption[] {
  return value === "" || list.some((o) => o.value === value) ? list : [{ value, label }, ...list];
}

/** Harness, profile and model selects. A select with one usable choice is disabled and shows it. */
export function Pickers({ options, selection, onChange, locked, modelUsed }: PickersProps) {
  const state = resolvePickers(options, selection);
  const sel = state.selection;
  const harnessOpts = withCurrent(
    state.harness.options.map((h) => ({ value: h.id, label: h.label, disabledReason: harnessUsable(h) ? null : harnessProblem(h) })),
    sel.harness,
    sel.harness,
  );
  const profileOpts = withCurrent(
    state.profile.options.map((p) => ({ value: p.name, label: p.name, description: p.description, disabledReason: profileUsable(p) ? null : profileProblem(p) })),
    sel.profile,
    sel.profile,
  );
  const modelOpts = withCurrent(
    state.model.options.map((m) => ({ value: m.id, label: m.label, detail: m.id, description: m.description })),
    sel.model ?? "",
    modelLabel(options, sel),
  );
  const lockNote = locked ? "locked while a reply is running" : null;
  const only = (n: number, what: string): string | null => (n === 1 ? `only ${what} available` : null);
  const harnessNote = lockNote ?? state.harness.reason ?? (state.harness.locked ? only(1, "harness") : null);
  const profileNote = lockNote ?? state.profile.reason ?? (state.profile.locked ? only(1, "profile") : null);
  const modelNote = lockNote ?? state.model.reason ?? (state.model.locked ? only(1, "model") : null);
  return (
    <div className="pickers" data-testid="pickers">
      <PickerSelect
        testId="picker-harness"
        label="Harness"
        value={sel.harness}
        options={harnessOpts}
        disabled={locked || state.harness.locked}
        note={harnessNote}
        onChange={(harness) => {
          onChange(resolvePickers(options, { harness, profile: "", model: null }).selection);
        }}
      />
      <PickerSelect
        testId="picker-profile"
        label="Profile"
        value={sel.profile}
        options={profileOpts}
        disabled={locked || state.profile.locked}
        note={profileNote}
        onChange={(profile) => {
          onChange(resolvePickers(options, { harness: sel.harness, profile, model: null }).selection);
        }}
      />
      <PickerSelect
        testId="picker-model"
        label="Model"
        value={sel.model ?? ""}
        options={modelOpts}
        disabled={locked || state.model.locked}
        note={modelNote}
        onChange={(model) => {
          onChange({ ...sel, model });
        }}
      />
      <p className="pickers-meta">
        {memoryNote(state.harness.options.find((h) => h.id === state.harness.value))}
        {modelUsed !== null ? <span> · last reply used <code>{modelUsed}</code></span> : null}
        {state.problem !== null ? <span className="picker-problem" role="alert" data-testid="picker-problem">{state.problem}</span> : null}
      </p>
    </div>
  );
}

/** Which model a chat is using: the one the agent reported, else the one the chat is set to. */
export function pickerSummary(chat: Chat, options: ChatOptions | undefined, modelUsed: string | null): string {
  const configured = modelLabel(options, { harness: chat.harness, profile: chat.profile, model: chat.model_id });
  return `${chat.harness} · ${chat.profile} · ${modelUsed ?? configured}`;
}

/** Whether replies share one live process or each message starts its own. Null while the options load. */
export function sessionNote(chat: Chat, options: ChatOptions | undefined): string {
  const harness = options?.harnesses.find((h) => h.id === chat.harness);
  if (harness === undefined) {
    return "";
  }
  return memoryNote(harness);
}
