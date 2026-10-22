// Client-side replica: an in-memory map of records, persisted by a pluggable
// adapter (IndexedDB in the web app, a JSON file in the Supernote plugin) and
// synchronised with the server through `sync()`.

import { localTZ } from "./dates";
import { HLC, mergeRec, maxClock, randomId, stamp, stampAll, type SyncRequest, type SyncResponse } from "./sync";
import { SETTINGS_ID, type Project, type Rec, type Settings, type Space, type Task } from "./types";

export interface StoreMeta {
  node: string;
  seq: number;
  dirty: string[];
  lastSync?: number;
}

export interface Persistence {
  load(): Promise<{ recs: Rec[]; meta: StoreMeta | null }>;
  /** called with the records that changed (or all, on first save) and the meta */
  save(changed: Rec[], meta: StoreMeta): Promise<void>;
}

export type Transport = (req: SyncRequest) => Promise<SyncResponse>;

/** Clock value older than any real edit: defaults never overwrite synced settings. */
const ZERO = "000000000.0000.init";
const WEAK = "000000001.0000.init";

export function defaultSettings(): Settings {
  const s: Settings = {
    id: SETTINGS_ID,
    kind: "settings",
    _c: {},
    createdAt: new Date(0).toISOString(),
    tz: localTZ(),
    weekStart: 1,
    digestEnabled: true,
    digestTime: "07:30",
    autoPlannedOffset: 0,
    autoDueOffset: 60,
    dueEveTime: "20:00",
    allDayTime: "09:00",
    icsIncludeDue: true,
    feeds: [],
    dayStart: "07:00",
    dayEnd: "23:00",
  };
  for (const k of Object.keys(s)) if (!["id", "kind", "_c"].includes(k)) s._c[k] = ZERO;
  // The device's own time zone is a weak default: it reaches a server that has none,
  // but any explicit choice (any real clock) wins over it.
  s._c.tz = WEAK;
  return s;
}

export class Store {
  readonly recs = new Map<string, Rec>();
  readonly dirty = new Set<string>();
  clock!: HLC;
  meta!: StoreMeta;
  version = 0;
  private listeners = new Set<() => void>();
  private pendingSave = new Map<string, Rec>();
  private batchDepth = 0;
  private syncing: Promise<SyncResponse | null> | null = null;

  constructor(private persist: Persistence) {}

  async init() {
    const { recs, meta } = await this.persist.load();
    this.meta = meta ?? { node: randomId(6), seq: 0, dirty: [] };
    this.clock = new HLC(this.meta.node);
    for (const r of recs) {
      this.recs.set(r.id, r);
      const mc = maxClock(r);
      if (mc) this.clock.observe(mc);
    }
    this.meta.dirty.forEach((id) => this.dirty.add(id));
    if (!this.recs.has(SETTINGS_ID)) {
      this.recs.set(SETTINGS_ID, defaultSettings());
      this.dirty.add(SETTINGS_ID);
    }
    this.version++;
  }

  // ---------- reads ----------

  get settings(): Settings {
    return { ...defaultSettings(), ...(this.recs.get(SETTINGS_ID) as Settings) };
  }
  get tasks(): Task[] {
    const out: Task[] = [];
    for (const r of this.recs.values()) if (r.kind === "task" && !r.deleted) out.push(r);
    return out;
  }
  get projects(): Project[] {
    return [...this.recs.values()]
      .filter((r): r is Project => r.kind === "project" && !r.deleted)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
  get spaces(): Space[] {
    return [...this.recs.values()]
      .filter((r): r is Space => r.kind === "space" && !r.deleted)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
  get<T extends Rec = Rec>(id: string): T | undefined {
    return this.recs.get(id) as T | undefined;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- writes ----------

  /** Group several writes into one save and one re-render. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.flush();
    }
  }

  insert<T extends Rec>(rec: T): T {
    const stamped = stampAll(rec, this.clock);
    this.write(stamped, true);
    return stamped;
  }

  update<T extends Rec>(id: string, patch: Partial<T>): T | undefined {
    const cur = this.recs.get(id) as T | undefined;
    if (!cur) return undefined;
    const next = stamp(cur, patch, this.clock);
    if (next === cur || maxClock(next) === maxClock(cur)) return cur;
    this.write(next, true);
    return next;
  }

  private write(rec: Rec, local: boolean) {
    this.recs.set(rec.id, rec);
    if (local) this.dirty.add(rec.id);
    this.pendingSave.set(rec.id, rec);
    if (this.batchDepth === 0) this.flush();
  }

  private flush() {
    if (!this.pendingSave.size) return;
    const changed = [...this.pendingSave.values()];
    this.pendingSave.clear();
    this.meta.dirty = [...this.dirty];
    this.version++;
    void this.persist.save(changed, this.meta);
    this.listeners.forEach((fn) => fn());
  }

  /** Merge records from the server (or an import). Does not mark them dirty. */
  applyRemote(recs: Rec[]) {
    this.batch(() => {
      for (const r of recs) {
        const mc = maxClock(r);
        if (mc) this.clock.observe(mc);
        const { rec, changed } = mergeRec(this.recs.get(r.id), r);
        if (changed) this.write(rec, false);
      }
    });
  }

  // ---------- sync ----------

  sync(send: Transport): Promise<SyncResponse | null> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      let last: SyncResponse | null = null;
      try {
        for (let round = 0; round < 50; round++) {
          const changes = [...this.dirty].map((id) => this.recs.get(id)).filter(Boolean) as Rec[];
          const sent = new Map(changes.map((r) => [r.id, maxClock(r)]));
          const res = await send({ since: this.meta.seq, changes });
          for (const [id, mc] of sent) {
            const cur = this.recs.get(id);
            if (cur && maxClock(cur) === mc) this.dirty.delete(id);
          }
          this.applyRemote(res.changes);
          this.meta.seq = res.seq;
          this.meta.lastSync = Date.now();
          this.meta.dirty = [...this.dirty];
          void this.persist.save([], this.meta);
          last = res;
          if (!res.more) break;
        }
        return last;
      } finally {
        this.syncing = null;
        this.listeners.forEach((fn) => fn());
      }
    })();
    return this.syncing;
  }

  /** Full export (backup). */
  dump(): Rec[] {
    return [...this.recs.values()];
  }
}

/** A Persistence that keeps nothing (tests, previews). */
export const memoryPersistence = (): Persistence => {
  let recs: Rec[] = [];
  let meta: StoreMeta | null = null;
  return {
    async load() {
      return { recs, meta };
    },
    async save(changed, m) {
      const map = new Map(recs.map((r) => [r.id, r]));
      for (const r of changed) map.set(r.id, r);
      recs = [...map.values()];
      meta = { ...m };
    },
  };
};
