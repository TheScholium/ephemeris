// Storage, pairing and sync for the Supernote plugin. The task logic itself is the
// shared core (src/core, copied from packages/core), so a task completed on the Nomad
// behaves exactly as on the Mac: recurring tasks create their next instance, etc.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { PluginManager } from "sn-plugin-lib";
import { Store, type Persistence, type Rec, type StoreMeta, type SyncRequest, type SyncResponse } from "./core";

const PREFIX = "eph.rec.";
const META = "eph.meta";
const CONFIG = "eph.config";

export interface Config {
  server: string;
  token: string;
}

function persistence(): Persistence {
  return {
    async load() {
      try {
        const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
        const recs: Rec[] = [];
        for (let i = 0; i < keys.length; i += 200) {
          const pairs = await AsyncStorage.multiGet(keys.slice(i, i + 200));
          for (const [, v] of pairs) if (v) recs.push(JSON.parse(v));
        }
        const m = await AsyncStorage.getItem(META);
        return { recs, meta: m ? (JSON.parse(m) as StoreMeta) : null };
      } catch {
        return { recs: [], meta: null };
      }
    },
    async save(changed, meta) {
      try {
        const pairs: [string, string][] = changed.map((r) => [PREFIX + r.id, JSON.stringify(r)]);
        pairs.push([META, JSON.stringify(meta)]);
        await AsyncStorage.multiSet(pairs);
      } catch (e) {
        console.warn("ephemeris: save failed", e);
      }
    },
  };
}

export const store = new Store(persistence());
let ready: Promise<void> | null = null;
export const init = () => (ready ??= store.init());

export async function loadConfig(): Promise<Config | null> {
  try {
    const v = await AsyncStorage.getItem(CONFIG);
    return v ? (JSON.parse(v) as Config) : null;
  } catch {
    return null;
  }
}

export async function saveConfig(c: Config | null) {
  if (c) await AsyncStorage.setItem(CONFIG, JSON.stringify(c));
  else await AsyncStorage.removeItem(CONFIG);
}

/** Network access needs the user's permission once ("Always allow" keeps it). */
export async function ensureInternet(): Promise<boolean> {
  const p = "plugin.permission.INTERNET";
  try {
    if ((await PluginManager.hasPermission(p)) === 1) return true;
    const r = await PluginManager.requestPermission(p, "Ephemeris syncs your tasks with your own server.");
    return r === 1 || r === 2;
  } catch {
    // older firmware without the permission system
    return true;
  }
}

const base = (server: string) => {
  let s = server.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
};

export async function pair(server: string, code: string): Promise<Config> {
  if (!(await ensureInternet())) throw new Error("Network permission was not granted.");
  const url = base(server);
  const r = await fetch(`${url}/api/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.token) throw new Error(body.error ?? `Server answered ${r.status}`);
  const c = { server: url, token: body.token as string };
  await saveConfig(c);
  return c;
}

export async function sync(c: Config): Promise<void> {
  if (!(await ensureInternet())) throw new Error("Network permission was not granted.");
  const send = async (req: SyncRequest): Promise<SyncResponse> => {
    const r = await fetch(`${c.server}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.token}` },
      body: JSON.stringify(req),
    });
    if (r.status === 401) throw new Error("The server refused the token. Pair again.");
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    return r.json();
  };
  await store.sync(send);
}

/** The device's local date (the Nomad's clock and time zone). */
export function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const nowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
