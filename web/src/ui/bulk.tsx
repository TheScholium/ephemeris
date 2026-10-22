import { useState } from "preact/hooks";
import { bulkAddTags, bulkComplete, bulkRemoveTags, bulkUpdate, fmtDuration, type ISODate, type Task } from "@ephemeris/core";
import { Icon } from "./icons";
import { Popover, ProjectSelect, deleteWithUndo, quickDates, useAnchor } from "./common";
import { clearSelection, selectMode, selection, showToast, store, today, useAtom } from "../state";

export function BulkBar() {
  const sel = useAtom(selection);
  const mode = useAtom(selectMode);
  const tagA = useAnchor();
  const projA = useAnchor();
  const planA = useAnchor();
  const dueA = useAnchor();
  const estA = useAnchor();
  const [newTag, setNewTag] = useState("");
  if (!sel.size && !mode) return null;
  const ids = [...sel];
  const tasks = ids.map((id) => store.get<Task>(id)).filter(Boolean) as Task[];
  const present = [...new Set(tasks.flatMap((t) => t.tags))].sort();
  const td = today();
  const n = ids.length;
  const done = (msg: string) => showToast(`${msg} (${n} task${n === 1 ? "" : "s"})`);

  const DatePop = ({ field, close }: { field: "planned" | "due"; close: () => void }) => (
    <div class="pop-body">
      <div class="chips">
        {quickDates(td, store.settings.weekStart).map((q) => (
          <button class="chip" onClick={() => {
            bulkUpdate(store, ids, { [field]: q.date } as Partial<Task>);
            done(`${field === "planned" ? "Planned" : "Due"} ${q.label.toLowerCase()}`);
            close();
          }}>{q.label}</button>
        ))}
      </div>
      <input type="date" aria-label="Pick a date" onChange={(e) => {
        const d = e.currentTarget.value as ISODate;
        if (!d) return;
        bulkUpdate(store, ids, { [field]: d } as Partial<Task>);
        done(field === "planned" ? "Planned" : "Deadline set");
        close();
      }} />
      <button class="link-btn" onClick={() => {
        bulkUpdate(store, ids, field === "planned" ? { planned: null, plannedTime: null } : { due: null, dueTime: null });
        done(field === "planned" ? "Plan cleared" : "Deadline cleared");
        close();
      }}>Clear {field === "planned" ? "plan" : "deadline"}</button>
    </div>
  );

  return (
    <div class="bulk" role="toolbar" aria-label="Selected tasks">
      <span class="bulk-n">{n ? `${n} selected` : "Tap tasks to select"}</span>
      {n > 0 && (
        <>
          <button class="bulk-btn" onClick={tagA.open}><Icon name="tag" /> Tags</button>
          <button class="bulk-btn" onClick={projA.open}><Icon name="folder" /> Project</button>
          <button class="bulk-btn" onClick={planA.open}><Icon name="plan" /> Plan</button>
          <button class="bulk-btn" onClick={dueA.open}><Icon name="due" /> Due</button>
          <button class="bulk-btn" onClick={estA.open}><Icon name="clock" /> Estimate</button>
          <button class="bulk-btn" onClick={() => {
            bulkComplete(store, ids, td);
            done("Completed");
            clearSelection();
          }}><Icon name="check" /> Done</button>
          <button class="bulk-btn danger" onClick={() => {
            deleteWithUndo(ids);
            clearSelection();
          }}><Icon name="trash" /> Delete</button>
        </>
      )}
      <button class="bulk-btn" onClick={clearSelection}><Icon name="x" /> {n ? "Clear" : "Cancel"}</button>

      {tagA.el && (
        <Popover anchor={tagA.el} onClose={tagA.close}>
          <div class="pop-body">
            <form onSubmit={(e) => {
              e.preventDefault();
              const t = newTag.replace(/^#/, "").trim().replace(/\s+/g, "-");
              if (!t) return;
              bulkAddTags(store, ids, [t]);
              done(`Added #${t}`);
              setNewTag("");
            }}>
              <input value={newTag} placeholder="Add a tag to all" onInput={(e) => setNewTag(e.currentTarget.value)} autoFocus />
            </form>
            {present.length > 0 && <p class="dim small">Remove from all:</p>}
            <div class="chips">
              {present.map((t) => (
                <button class="chip" onClick={() => {
                  bulkRemoveTags(store, ids, [t]);
                  done(`Removed #${t}`);
                }}>#{t} <Icon name="x" size={10} /></button>
              ))}
            </div>
          </div>
        </Popover>
      )}
      {projA.el && (
        <Popover anchor={projA.el} onClose={projA.close}>
          <div class="pop-body">
            <ProjectSelect value={null} onChange={(projectId) => {
              bulkUpdate(store, ids, { projectId });
              done("Moved");
              projA.close();
            }} />
          </div>
        </Popover>
      )}
      {planA.el && <Popover anchor={planA.el} onClose={planA.close}><DatePop field="planned" close={planA.close} /></Popover>}
      {dueA.el && <Popover anchor={dueA.el} onClose={dueA.close}><DatePop field="due" close={dueA.close} /></Popover>}
      {estA.el && (
        <Popover anchor={estA.el} onClose={estA.close}>
          <div class="pop-body chips">
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <button class="chip" onClick={() => {
                bulkUpdate(store, ids, { estimate: m });
                done(`Estimate ${fmtDuration(m)}`);
                estA.close();
              }}>{fmtDuration(m)}</button>
            ))}
            <button class="chip" onClick={() => {
              bulkUpdate(store, ids, { estimate: null });
              estA.close();
            }}>None</button>
          </div>
        </Popover>
      )}
    </div>
  );
}
