import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { describeRule, fmtDuration, fmtTime12, parseTask, quickAdd, relDate, type Task } from "@ephemeris/core";
import { Icon } from "./icons";
import { parseCtx, showToast, store, today } from "../state";

export const quickAddFocus = { fn: null as null | (() => void) };

export function QuickAdd({ defaults = {}, placeholder, autoFocus, onAdded }: {
  defaults?: Partial<Task>; placeholder?: string; autoFocus?: boolean; onAdded?: (t: Task) => void;
}) {
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const parsed = text.trim() ? parseTask(text, parseCtx(), store.projects.map((p) => p.name)) : null;

  useEffect(() => {
    quickAddFocus.fn = () => ta.current?.focus();
    if (autoFocus) ta.current?.focus();
    return () => {
      quickAddFocus.fn = null;
    };
  }, []);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [text]);

  const submit = () => {
    if (!text.trim()) return;
    const t = quickAdd(store, text, parseCtx(), defaults);
    setText("");
    const when = t.planned ? `planned ${relDate(t.planned, today())}` : t.due ? `due ${relDate(t.due, today())}` : "added to Inbox";
    showToast(`${t.title}: ${when}`);
    onAdded?.(t);
  };

  // mirror with highlighted spans
  const pieces: preact.JSX.Element[] = [];
  if (parsed) {
    let at = 0;
    for (const s of parsed.spans) {
      if (s.start > at) pieces.push(<span>{text.slice(at, s.start)}</span>);
      pieces.push(<mark class={`hl-${s.kind}`}>{text.slice(s.start, s.end)}</mark>);
      at = s.end;
    }
    pieces.push(<span>{text.slice(at)}</span>);
  }

  const td = today();
  return (
    <div class="qa">
      <div class="qa-field">
        <Icon name="plus" class="qa-plus" />
        <div class="qa-stack">
          <div class="qa-mirror" aria-hidden="true">{pieces}{"​"}</div>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            spellcheck={false}
            placeholder={placeholder ?? "New task: read Lee ch. 3 tomorrow 9am for 90m due fri #drp"}
            aria-label="New task"
            onInput={(e) => setText(e.currentTarget.value.replace(/\n/g, " "))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setText("");
                ta.current?.blur();
              }
            }}
          />
        </div>
        <button class="qa-help" aria-label="Quick add syntax" onClick={() => setHelp(!help)}>?</button>
      </div>
      {parsed && (
        <div class="qa-preview" aria-live="polite">
          <span class="qp-title">{parsed.title || <em>Untitled</em>}</span>
          {parsed.planned && <span class="qp plan"><Icon name="plan" size={12} />{relDate(parsed.planned, td)}{parsed.plannedTime ? " " + fmtTime12(parsed.plannedTime) : ""}</span>}
          {parsed.due && <span class="qp due"><Icon name="due" size={12} />{relDate(parsed.due, td)}{parsed.dueTime ? " " + fmtTime12(parsed.dueTime) : ""}</span>}
          {parsed.estimate && <span class="qp"><Icon name="clock" size={12} />{fmtDuration(parsed.estimate)}</span>}
          {parsed.recurrence && <span class="qp rep"><Icon name="repeat" size={12} />{describeRule(parsed.recurrence)}</span>}
          {parsed.project && <span class="qp"><Icon name="folder" size={12} />{parsed.project}{!store.projects.some((p) => p.name.toLowerCase() === parsed.project!.toLowerCase()) && <em> (new)</em>}</span>}
          {parsed.tags.map((t) => <span class="qp tag">#{t}</span>)}
          {parsed.reminders.length > 0 && <span class="qp"><Icon name="bell" size={12} />{parsed.reminders.map((r) => (r.offset ? fmtDuration(r.offset) + " before" : "at time")).join(", ")}</span>}
          {parsed.starred && <span class="qp"><Icon name="star" size={12} />starred</span>}
          {!parsed.planned && !parsed.due && defaults.planned && <span class="qp plan dim"><Icon name="plan" size={12} />{relDate(defaults.planned, td)}</span>}
        </div>
      )}
      {help && <SyntaxHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

export function SyntaxHelp({ onClose }: { onClose?: () => void }) {
  const rows: [string, string][] = [
    ["tomorrow 9am, fri, next mon, oct 28, in 3 days", "planned date and time"],
    ["due fri 5pm, by oct 30, before next week", "deadline"],
    ["3-5pm, at 2:30", "planned time (a range also sets the estimate)"],
    ["for 45m, ~1h30, (2h)", "time estimate"],
    ["every weekday, every mon, wed, every 2 weeks", "repeat on a schedule"],
    ["every month on the last fri, every year on nov 12", "monthly and yearly patterns"],
    ["every 3 days after done", "repeat counted from completion"],
    ["#tag, #school/phys311", "tags (a slash makes a nested tag)"],
    ["+Project, +Long_name", "project (underscore for a space)"],
    ["remind 15m before, !", "reminder, star"],
    ['"Read Sunday Times"', "quoted text is never parsed"],
  ];
  return (
    <div class="syntax">
      <table>
        <tbody>
          {rows.map(([a, b]) => <tr><td><code>{a}</code></td><td>{b}</td></tr>)}
        </tbody>
      </table>
      <p class="dim">Weekday names mean the next one (on a Wednesday, "wed" is next week). "next fri" means Friday of next week. A time that has passed today moves to tomorrow.</p>
      {onClose && <button class="link-btn" onClick={onClose}>Close</button>}
    </div>
  );
}
