import { useEffect, useId, useRef, useState } from "react";
import { QUESTION_DISMISS_AFTER_MS, type QuestionItem, type QuestionPart } from "../../shared/chat-question";

interface Props {
  part: QuestionPart;
  /** Sends the answers, or skips with null. Resolves to an error text, or null when it went through. */
  onSubmit: (answers: string[][] | null) => Promise<string | null>;
  /** Shown above the composer while the question waits. */
  pinned?: boolean;
  now?: number;
}

const OTHER = "\u0000other";

const summary = (answers: string[][] | undefined): string => (answers ?? []).map((a) => a.join(", ")).join(" · ");

/** The agent's question, in the thread (answered: one quiet line that opens) and pinned above the composer (pending: answer it). */
export function QuestionCard({ part, onSubmit, pinned = false, now }: Props) {
  if (part.state === "pending") {
    return pinned ? <PendingCard part={part} onSubmit={onSubmit} now={now ?? Date.now()} /> : (
      <p className="qnote" data-testid="question-waiting">
        <span className="qdot" aria-hidden="true" />
        {part.questions[0]?.header || "Question"}: waiting for your answer
      </p>
    );
  }
  return <SettledCard part={part} />;
}

function SettledCard({ part }: { part: QuestionPart }) {
  const [open, setOpen] = useState(false);
  const answered = part.state === "answered";
  return (
    <div className="qcard is-settled" data-testid="question-card" data-state={part.state}>
      <button type="button" className="qsum" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <span className="qcaret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="qlabel">{answered ? "Answered" : "Skipped"}</span>
        <span className="qshort">{answered ? summary(part.answers) : part.questions[0]?.question}</span>
      </button>
      {open ? (
        <dl className="qlist" data-testid="question-answers">
          {part.questions.map((q, i) => (
            <div key={i}>
              <dt>{q.header === "" ? q.question : `${q.header}: ${q.question}`}</dt>
              <dd>{answered ? (part.answers?.[i] ?? []).join(", ") : "Skipped"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

interface Pick { chosen: string[]; other: boolean; custom: string }
const EMPTY: Pick = { chosen: [], other: false, custom: "" };

function answerOf(q: QuestionItem, p: Pick): string[] {
  const typed = p.other && p.custom.trim() !== "" ? [p.custom.trim()] : [];
  return [...p.chosen, ...typed];
}

function PendingCard({ part, onSubmit, now }: { part: QuestionPart; onSubmit: Props["onSubmit"]; now: number }) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Pick[]>(() => part.questions.map(() => EMPTY));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const id = useId();
  const q = part.questions[step] as QuestionItem;
  const pick = picks[step] ?? EMPTY;
  const last = step === part.questions.length - 1;
  const ready = answerOf(q, pick).length > 0;
  const stale = now - Date.parse(part.asked_at) > QUESTION_DISMISS_AFTER_MS;

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    root.current?.querySelector<HTMLElement>("input:checked, input[type=radio], input[type=checkbox]")?.focus({ preventScroll: true });
  }, [step]);

  const update = (next: Pick): void => {
    setPicks(picks.map((p, i) => (i === step ? next : p)));
    setError(null);
  };
  const toggle = (label: string): void => {
    if (q.multiple) {
      update({ ...pick, chosen: pick.chosen.includes(label) ? pick.chosen.filter((c) => c !== label) : [...pick.chosen, label] });
    } else {
      update({ chosen: [label], other: false, custom: pick.custom });
    }
  };
  const toggleOther = (): void => {
    update(q.multiple ? { ...pick, other: !pick.other } : { chosen: [], other: true, custom: pick.custom });
  };

  const submit = async (answers: string[][] | null): Promise<void> => {
    setSending(true);
    setError(null);
    const failure = await onSubmit(answers);
    if (failure !== null) {
      setError(failure);
      setSending(false);
    }
  };
  const advance = (): void => {
    if (!ready || sending) {
      return;
    }
    if (last) {
      void submit(part.questions.map((item, i) => answerOf(item, picks[i] ?? EMPTY)));
    } else {
      setStep(step + 1);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (sending || e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" && (target as HTMLInputElement).type === "text";
    if (e.key === "Enter" && target.tagName !== "BUTTON") {
      e.preventDefault();
      advance();
    } else if (!typing && /^[1-9]$/.test(e.key)) {
      const option = q.options[Number(e.key) - 1];
      if (option !== undefined) {
        e.preventDefault();
        toggle(option.label);
      }
    } else if (!typing && (e.key === "ArrowDown" || e.key === "ArrowUp") && q.multiple) {
      const inputs = [...(root.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [])];
      const at = inputs.indexOf(target as HTMLInputElement);
      if (at >= 0) {
        e.preventDefault();
        inputs[(at + (e.key === "ArrowDown" ? 1 : -1) + inputs.length) % inputs.length]?.focus();
      }
    }
  };

  const kind = q.multiple ? "checkbox" : "radio";
  return (
    <section className="qcard is-pending" ref={root} aria-labelledby={`${id}-q`} data-testid="question-card" data-state="pending" onKeyDown={onKeyDown}>
      <div className="qhead">
        <span className="qdot" aria-hidden="true" />
        <span className="qlabel">{q.header === "" ? "Question" : q.header}</span>
        {part.questions.length > 1 ? <span className="qstep" data-testid="question-step">{step + 1} of {part.questions.length}</span> : null}
      </div>
      <p className="qtext" id={`${id}-q`}>{q.question}</p>
      <div className="qopts" role={q.multiple ? "group" : "radiogroup"} aria-labelledby={`${id}-q`} key={step}>
        {q.options.map((o, i) => (
          <label className="qopt" key={o.label} data-checked={pick.chosen.includes(o.label) || undefined}>
            <input type={kind} name={`${id}-${step}`} checked={pick.chosen.includes(o.label)} disabled={sending} onChange={() => { toggle(o.label); }} />
            <span className="qopt-body">
              <span className="qopt-label">{o.label}</span>
              {o.description !== "" ? <span className="qopt-desc">{o.description}</span> : null}
            </span>
            {i < 9 ? <kbd className="qkey" aria-hidden="true">{i + 1}</kbd> : null}
          </label>
        ))}
        {q.allowCustom ? (
          <div className="qopt qother" data-checked={pick.other || undefined}>
            <input type={kind} name={`${id}-${step}`} value={OTHER} aria-label="Other" checked={pick.other} disabled={sending} onChange={toggleOther} />
            <input
              type="text"
              className="input qinput"
              placeholder="Other: type your own answer"
              aria-label="Other answer"
              value={pick.custom}
              disabled={sending}
              onChange={(e) => { update({ ...(q.multiple ? pick : { chosen: [], other: true, custom: "" }), other: true, custom: e.target.value }); }}
              onFocus={() => { if (!pick.other) { update(q.multiple ? { ...pick, other: true } : { chosen: [], other: true, custom: pick.custom }); } }}
            />
          </div>
        ) : null}
      </div>
      {stale ? <p className="qhint" data-testid="question-stale">Asked over a day ago. The agent has stopped waiting: skip it to move on.</p> : null}
      {error !== null ? <p className="qerror" role="alert" data-testid="question-error">{error}</p> : null}
      <div className="qactions">
        <button type="button" className="btn qskip" disabled={sending} onClick={() => void submit(null)}>Skip</button>
        {step > 0 ? <button type="button" className="btn" disabled={sending} onClick={() => { setStep(step - 1); }}>Back</button> : null}
        <button type="button" className="btn primary qsend" disabled={!ready || sending} onClick={advance} data-testid="question-send">
          {sending ? "Sending…" : last ? "Send answer" : "Next"}
        </button>
      </div>
    </section>
  );
}
