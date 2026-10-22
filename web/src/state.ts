// App state: the replicated store, the connection to the server, sync scheduling,
// and a few small shared UI atoms.

import { useEffect, useState } from "preact/hooks";
import {
  Store, todayIn, epochToZoned, parseHM, type Persistence, type Rec, type StoreMeta, type SyncRequest, type SyncResponse,
} from "@ephemeris/core";

// ---------- tiny atoms ----------

export class Atom<T> {
  private subs = new Set<(v: T) => void>();
  constructor(private v: T) {}
  get value() {
    return this.v;
  }
  set(v: T) {
    if (Object.is(v, this.v)) return;
    this.v = v;
    this.subs.forEach((f) => f(v));
  }
  update(fn: (v: T) => T) {
    this.set(fn(this.v));
  }
  subscribe(f: (v: T) => void) {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
}

export function useAtom<T>(a: Atom<T>): T {
  const [, force] = useState(0);
  useEffect(() => a.subscribe(() => force((n) => n + 1)), [a]);
  return a.value;
}

// ---------- persistence (IndexedDB) ----------

function idbPersistence(): Persistence {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () =>
    (dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open("ephemeris", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("recs", { keyPath: "id" });
        r.result.createObjectStore("meta");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  return {
    async load() {
      try {
        const db = await open();
        const tx = db.transaction(["recs", "meta"], "readonly");
        const recs = await new Promise<Rec[]>((res) => {
          const q = tx.objectStore("recs").getAll();
          q.onsuccess = () => res(q.result as Rec[]);
        });
        const meta = await new Promise<StoreMeta | null>((res) => {
          const q = tx.objectStore("meta").get("meta");
          q.onsuccess = () => res((q.result as StoreMeta) ?? null);
        });
        return { recs, meta };
      } catch {
        return { recs: [], meta: null };
      }
    },
    async save(changed, meta) {
      try {
        const db = await open();
        const tx = db.transaction(["recs", "meta"], "readwrite");
        const os = tx.objectStore("recs");
        for (const r of changed) os.put(r);
        tx.objectStore("meta").put(meta, "meta");
        await done(tx);
      } catch (e) {
        console.warn("save failed", e);
      }
    },
  };
}

export const store = new Store(idbPersistence());

export function useStore(): number {
  const [v, setV] = useState(store.version);
  useEffect(() => store.subscribe(() => setV(store.version)), []);
  return v;
}

// ---------- connection ----------

const LS = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const LSset = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private mode */
  }
};

export interface Conn {
  server: string;
  token: string;
}
export const conn = new Atom<Conn>({ server: LS("eph.server"), token: LS("eph.token") });
conn.subscribe((c) => {
  LSset("eph.server", c.server);
  LSset("eph.token", c.token);
});

/** API base: explicit server, or this origin when the app is served by the Worker. */
export function apiBase(): string {
  return (conn.value.server || location.origin).replace(/\/+$/, "");
}
export const connected = () => !!conn.value.token;

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${conn.value.token}`);
  return fetch(apiBase() + path, { ...init, headers });
}

export async function apiJSON<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await api(path, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json();
}

// ---------- sync ----------

export interface SyncState {
  status: "local" | "idle" | "syncing" | "error" | "offline";
  last: number | null;
  error: string | null;
}
export const syncState = new Atom<SyncState>({ status: "local", last: null, error: null });

const transport = async (req: SyncRequest): Promise<SyncResponse> =>
  apiJSON<SyncResponse>("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });

let timer: ReturnType<typeof setTimeout> | null = null;

export async function syncNow() {
  if (!connected()) {
    syncState.set({ status: "local", last: null, error: null });
    return;
  }
  if (!navigator.onLine) {
    syncState.set({ ...syncState.value, status: "offline" });
    return;
  }
  syncState.set({ ...syncState.value, status: "syncing" });
  try {
    await store.sync(transport);
    syncState.set({ status: "idle", last: Date.now(), error: null });
  } catch (e: any) {
    syncState.set({ ...syncState.value, status: "error", error: String(e?.message ?? e) });
  }
}

export function scheduleSync(delay = 1200) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

export async function boot() {
  await store.init();
  // pairing link: #/pair?server=...&token=...
  const m = location.hash.match(/^#\/pair\?(.*)$/);
  if (m) {
    const p = new URLSearchParams(m[1]);
    conn.set({ server: p.get("server") ?? conn.value.server, token: p.get("token") ?? "" });
    history.replaceState(null, "", "#/today");
  }
  let lastDirty = store.dirty.size;
  store.subscribe(() => {
    if (store.dirty.size && store.dirty.size !== lastDirty) scheduleSync();
    lastDirty = store.dirty.size;
  });
  conn.subscribe(() => void syncNow());
  void syncNow();
  setInterval(() => {
    if (document.visibilityState === "visible") void syncNow();
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncNow();
      clock.set(Date.now());
    }
  });
  addEventListener("online", () => void syncNow());
  setInterval(() => clock.set(Date.now()), 30_000);
}

// ---------- time ----------

/** Re-renders views at minute granularity (and when the app comes back). */
export const clock = new Atom<number>(Date.now());
export const today = () => todayIn(store.settings.tz, clock.value);
export const nowMinutes = () => parseHM(epochToZoned(Date.now(), store.settings.tz).time);
export const parseCtx = () => ({ today: today(), nowMinutes: nowMinutes(), weekStart: store.settings.weekStart });

// ---------- UI state ----------

export const openTask = new Atom<string | null>(null);
export const selection = new Atom<Set<string>>(new Set());
export const selectMode = new Atom<boolean>(false);
export const toast = new Atom<{ text: string; undo?: () => void } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(text: string, undo?: () => void) {
  toast.set({ text, undo });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.set(null), 5000);
}

export function toggleSelect(id: string, on?: boolean) {
  selection.update((s) => {
    const n = new Set(s);
    const want = on ?? !n.has(id);
    if (want) n.add(id);
    else n.delete(id);
    return n;
  });
}
export function clearSelection() {
  selection.set(new Set());
  selectMode.set(false);
}

// ---------- route ----------

export interface Route {
  view: string;
  arg?: string;
}
function readRoute(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const [view, ...rest] = h.split("/");
  return { view: view || "today", arg: rest.join("/") || undefined };
}
export const route = new Atom<Route>(readRoute());
addEventListener("hashchange", () => {
  const r = readRoute();
  if (r.view === "task" && r.arg) {
    openTask.set(r.arg);
    history.replaceState(null, "", "#/today");
    route.set({ view: "today" });
    return;
  }
  route.set(r);
  clearSelection();
});
export const go = (view: string, arg?: string) => {
  location.hash = `#/${view}${arg ? "/" + encodeURIComponent(arg) : ""}`;
};
// opening the app from a notification
{
  const r = readRoute();
  if (r.view === "task" && r.arg) {
    openTask.set(r.arg);
    route.set({ view: "today" });
  }
}

export const isWide = new Atom<boolean>(typeof matchMedia !== "undefined" && matchMedia("(min-width: 900px)").matches);
if (typeof matchMedia !== "undefined") {
  matchMedia("(min-width: 900px)").addEventListener("change", (e) => isWide.set(e.matches));
}
