// Field-level last-writer-wins replication with hybrid logical clocks.
//
// Each record keeps a clock per field (rec._c[field]). A merge takes, field by
// field, the value with the larger clock. Because the merge is commutative,
// associative and idempotent, devices can edit offline in any order and still
// converge: the Mac, the iPhone and the Supernote never need to agree on a
// "current version" of a task, only on per-field clocks.

import type { Rec } from "./types";

const NODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomId(len = 16): string {
  const bytes = new Uint8Array(len);
  const c = (globalThis as any).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256); // React Native without a crypto polyfill
  let s = "";
  for (const b of bytes) s += NODE_CHARS[b % NODE_CHARS.length];
  return s;
}

/** Deterministic id from a string (FNV-1a, 2 rounds). Used so that two devices that
 *  complete the same recurring task offline create the SAME next instance. */
export function stableId(seed: string): string {
  let out = "";
  for (let round = 0; round < 2; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(36).padStart(7, "0");
  }
  return "s" + out;
}

export class HLC {
  private last = 0;
  private counter = 0;
  constructor(public readonly node: string, private nowFn: () => number = Date.now) {}

  static encode(ms: number, counter: number, node: string) {
    return `${ms.toString(36).padStart(9, "0")}.${counter.toString(36).padStart(4, "0")}.${node}`;
  }
  static decode(c: string) {
    const [ms, counter, node] = c.split(".");
    return { ms: parseInt(ms, 36), counter: parseInt(counter, 36), node };
  }

  now(): string {
    const t = this.nowFn();
    if (t > this.last) {
      this.last = t;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return HLC.encode(this.last, this.counter, this.node);
  }

  /** Advance past a clock seen from another device (keeps causality under clock skew). */
  observe(remote: string) {
    const r = HLC.decode(remote);
    if (r.ms > this.last) {
      this.last = r.ms;
      this.counter = r.counter;
    } else if (r.ms === this.last && r.counter > this.counter) {
      this.counter = r.counter;
    }
  }
}

/**
 * Merge incoming record b into local record a. Returns the merged record and
 * whether anything in `a` changed.
 */
export function mergeRec<T extends Rec>(a: T | undefined, b: T): { rec: T; changed: boolean } {
  if (!a) return { rec: clone(b), changed: true };
  let changed = false;
  const out: any = { ...a, _c: { ...a._c } };
  for (const [field, clock] of Object.entries(b._c || {})) {
    const mine = a._c?.[field];
    if (!mine || clock > mine) {
      const v = (b as any)[field];
      if (v === undefined) delete out[field];
      else out[field] = clone(v);
      out._c[field] = clock;
      changed = true;
    }
  }
  return { rec: out as T, changed };
}

/** Apply a local edit, stamping every changed field with a fresh clock. */
export function stamp<T extends Rec>(rec: T, patch: Partial<T>, clock: HLC): T {
  const out: any = { ...rec, _c: { ...rec._c } };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || k === "kind" || k === "_c" || k === "createdAt") continue;
    if (sameValue(out[k], v)) continue;
    out[k] = clone(v);
    out._c[k] = clock.now();
  }
  return out as T;
}

/** Stamp all user fields of a brand-new record. */
export function stampAll<T extends Rec>(rec: T, clock: HLC): T {
  const c = clock.now();
  const _c: Record<string, string> = {};
  for (const k of Object.keys(rec)) {
    if (k === "id" || k === "kind" || k === "_c") continue;
    _c[k] = c;
  }
  return { ...rec, _c };
}

export function maxClock(rec: Rec): string {
  let m = "";
  for (const c of Object.values(rec._c || {})) if (c > m) m = c;
  return m;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function clone<T>(v: T): T {
  return v === undefined || v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v));
}

// ---------- wire protocol ----------

export interface SyncRequest {
  /** last server sequence number this device has seen */
  since: number;
  /** records changed on this device since its last successful sync */
  changes: Rec[];
}
export interface SyncResponse {
  seq: number;
  changes: Rec[];
  more: boolean;
}
