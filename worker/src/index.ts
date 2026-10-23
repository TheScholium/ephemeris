// Ephemeris server (Cloudflare Worker, free tier).
//
//   POST /api/sync              merge device changes, return server changes since a cursor
//   GET  /api/push/key          VAPID public key
//   POST /api/push/subscribe    register a device for notifications
//   POST /api/push/unsubscribe
//   POST /api/push/test         send a test notification to every device
//   GET  /api/push/devices
//   POST /api/files             upload an attachment (raw body, X-File-Name header)
//   GET  /api/files/:id         download an attachment
//   GET  /api/feed/:i           fetch external calendar #i from settings (CORS-free proxy)
//   GET  /api/export            JSON backup of everything
//   GET  /cal/<ICS_TOKEN>.ics   planned tasks as a subscribable calendar
//   cron (every minute)         send due reminders + daily summary

import {
  buildICS, defaultSettings, digest, epochToZoned, mergeRec, taskAlarms,
  type Rec, type Settings, type SyncRequest, type SyncResponse, type Task,
} from "@ephemeris/core";
import { sendPush, type PushKeys, type PushSub } from "./push";

export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
  ASSETS: Fetcher;
  API_TOKEN: string;
  ICS_TOKEN: string;
  VAPID_PUBLIC: string;
  VAPID_PRIVATE: string;
  VAPID_SUBJECT: string;
}

const KINDS = new Set(["task", "project", "space", "settings"]);
const PULL_LIMIT = 500;
const MAX_FILE = 25 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name",
  "Access-Control-Max-Age": "86400",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
const fail = (status: number, error: string) => json({ error }, status);

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isActive = (r: Rec) => (r.kind === "task" && r.status === "open" && !r.deleted ? 1 : 0);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/cal/")) return calendarFeed(env, url);
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (path === "/api/health") return json({ ok: true, app: "ephemeris" });
    if (path === "/api/pair/claim" && req.method === "POST") return claimPairing(env, await req.json().catch(() => ({})));

    const auth = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    if (!safeEqual(auth, env.API_TOKEN ?? "")) return fail(401, "unauthorized");

    try {
      if (path === "/api/sync" && req.method === "POST") return json(await sync(env, ctx, await req.json()));
      if (path === "/api/pair" && req.method === "POST") return startPairing(env);
      if (path === "/api/push/key") return json({ key: env.VAPID_PUBLIC ?? null });
      if (path === "/api/info") {
        return json({
          vapidKey: env.VAPID_PUBLIC ?? null,
          icsUrl: env.ICS_TOKEN ? `${url.origin}/cal/${env.ICS_TOKEN}.ics` : null,
          webcalUrl: env.ICS_TOKEN ? `webcal://${url.host}/cal/${env.ICS_TOKEN}.ics` : null,
        });
      }
      if (path === "/api/push/subscribe" && req.method === "POST") return subscribe(env, await req.json());
      if (path === "/api/push/unsubscribe" && req.method === "POST") {
        const { endpoint } = (await req.json()) as { endpoint: string };
        await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(endpoint).run();
        return json({ ok: true });
      }
      if (path === "/api/push/test" && req.method === "POST") {
        const n = await broadcast(env, { title: "Ephemeris", body: "Notifications work on this device.", url: "/", tag: "test" });
        return json({ sent: n });
      }
      if (path === "/api/push/devices") {
        const r = await env.DB.prepare("SELECT device, created FROM subscriptions ORDER BY created").all();
        return json(r.results);
      }
      if (path === "/api/files" && req.method === "POST") return upload(env, req);
      const fm = path.match(/^\/api\/files\/([\w-]+)$/);
      if (fm && req.method === "GET") return download(env, fm[1]);
      if (fm && req.method === "DELETE") {
        await env.FILES.delete(`file:${fm[1]}`);
        return json({ ok: true });
      }
      const feed = path.match(/^\/api\/feed\/(\d+)$/);
      if (feed) return feedProxy(env, Number(feed[1]));
      if (path === "/api/export") {
        const r = await env.DB.prepare("SELECT data FROM records").all<{ data: string }>();
        return json({ exported: new Date().toISOString(), records: r.results.map((x) => JSON.parse(x.data)) });
      }
      return fail(404, "not found");
    } catch (e: any) {
      console.error(e);
      return fail(500, String(e?.message ?? e));
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env));
  },
};

// ---------------- sync ----------------

function validRec(r: any): r is Rec {
  return r && typeof r.id === "string" && r.id.length <= 64 && KINDS.has(r.kind) && r._c && typeof r._c === "object";
}

async function loadRecs(env: Env, ids: string[]): Promise<Map<string, Rec>> {
  const out = new Map<string, Rec>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT data FROM records WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk).all<{ data: string }>();
    for (const row of r.results) {
      const rec = JSON.parse(row.data) as Rec;
      out.set(rec.id, rec);
    }
  }
  return out;
}

async function getSettings(env: Env): Promise<Settings> {
  const row = await env.DB.prepare("SELECT data FROM records WHERE id = 'settings'").first<{ data: string }>();
  return { ...defaultSettings(), ...(row ? JSON.parse(row.data) : {}) };
}

export async function sync(env: Env, ctx: ExecutionContext, body: SyncRequest): Promise<SyncResponse> {
  const since = Number(body?.since) || 0;
  const incoming = (Array.isArray(body?.changes) ? body.changes : []).filter(validRec).slice(0, 2000);

  if (incoming.length) {
    const existing = await loadRecs(env, [...new Set(incoming.map((r) => r.id))]);
    const writes: Rec[] = [];
    for (const r of incoming) {
      const { rec, changed } = mergeRec(existing.get(r.id), r);
      if (changed) {
        existing.set(r.id, rec);
        writes.push(rec);
      }
    }
    // dedupe (a record may appear twice in one request)
    const finalWrites = [...new Map(writes.map((w) => [w.id, existing.get(w.id)!])).values()];
    if (finalWrites.length) {
      const n = finalWrites.length;
      // One transaction: bump the counter and stamp each row with its own sequence number.
      const stmts = [env.DB.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + ? WHERE k = 'seq'").bind(n)];
      finalWrites.forEach((rec, i) => {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO records (id, kind, data, seq, active)
             VALUES (?1, ?2, ?3, (SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'seq') - ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, seq = excluded.seq, active = excluded.active`,
          ).bind(rec.id, rec.kind, JSON.stringify(rec), n - 1 - i, isActive(rec)),
        );
      });
      await env.DB.batch(stmts);
      ctx.waitUntil(refreshAlarms(env, finalWrites).catch((e) => console.error("alarms", e)));
    }
  }

  const rows = await env.DB.prepare("SELECT data, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?")
    .bind(since, PULL_LIMIT).all<{ data: string; seq: number }>();
  const more = rows.results.length === PULL_LIMIT;
  const head = await env.DB.prepare("SELECT CAST(v AS INTEGER) AS v FROM meta WHERE k = 'seq'").first<{ v: number }>();
  return {
    seq: more ? rows.results[rows.results.length - 1].seq : Math.max(head?.v ?? 0, since),
    changes: rows.results.map((r) => JSON.parse(r.data)),
    more,
  };
}

// ---------------- alarms ----------------

async function refreshAlarms(env: Env, changed: Rec[]) {
  const settingsChanged = changed.some((r) => r.kind === "settings");
  let tasks: Task[];
  if (settingsChanged) {
    const r = await env.DB.prepare("SELECT data FROM records WHERE active = 1").all<{ data: string }>();
    tasks = r.results.map((x) => JSON.parse(x.data));
    // inactive tasks among the changed ones still need their alarms cleared
    for (const c of changed) if (c.kind === "task" && !isActive(c)) tasks.push(c as Task);
  } else {
    tasks = changed.filter((r): r is Task => r.kind === "task");
  }
  if (!tasks.length) return;
  const settings = await getSettings(env);
  const parentIds = [...new Set(tasks.map((t) => t.parentId).filter(Boolean) as string[])];
  const parents = await loadRecs(env, parentIds);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const t of tasks) {
    stmts.push(env.DB.prepare("DELETE FROM alarms WHERE task_id = ? AND sent = 0").bind(t.id));
    const parentTitle = t.parentId ? (parents.get(t.parentId) as Task | undefined)?.title : undefined;
    for (const a of taskAlarms(t, settings, parentTitle)) {
      if (a.at < now - 60_000) continue;
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO alarms (id, task_id, fire_at, title, body, url) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(a.id, a.taskId, a.at, a.title, a.body, a.url),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

async function subs(env: Env): Promise<PushSub[]> {
  const r = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM subscriptions").all<PushSub>();
  return r.results;
}

const keys = (env: Env): PushKeys => ({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE });

async function broadcast(env: Env, msg: { title: string; body: string; url: string; tag: string }): Promise<number> {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return 0;
  let sent = 0;
  for (const s of await subs(env)) {
    try {
      const res = await sendPush(s, msg, keys(env));
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(s.endpoint).run();
      } else if (res.ok) sent++;
      else console.error("push", res.status, await res.text());
    } catch (e) {
      console.error("push error", e);
    }
  }
  return sent;
}

export async function tick(env: Env) {
  const now = Date.now();
  // 1. due reminders (missed ones up to 6 h late are still sent)
  const due = await env.DB.prepare(
    "SELECT id, title, body, url, task_id FROM alarms WHERE sent = 0 AND fire_at <= ? AND fire_at > ? ORDER BY fire_at LIMIT 50",
  ).bind(now, now - 6 * 3600_000).all<{ id: string; title: string; body: string; url: string; task_id: string }>();
  if (due.results.length) {
    const ids = due.results.map((a) => a.id);
    await env.DB.prepare(`UPDATE alarms SET sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
    for (const a of due.results) await broadcast(env, { title: a.title, body: a.body, url: a.url, tag: a.task_id });
  }

  // 2. daily summary
  const s = await getSettings(env);
  if (s.digestEnabled) {
    const local = epochToZoned(now, s.tz);
    if (local.time >= s.digestTime) {
      const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'digest'").first<{ v: string }>();
      if (last?.v !== local.date) {
        await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('digest', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
          .bind(local.date).run();
        const r = await env.DB.prepare("SELECT data FROM records WHERE active = 1").all<{ data: string }>();
        const d = digest(r.results.map((x) => JSON.parse(x.data)), local.date);
        if (d) await broadcast(env, { ...d, url: "/#/today", tag: "digest" });
        // housekeeping once a day
        await env.DB.prepare("DELETE FROM alarms WHERE sent = 1 AND fire_at < ?").bind(now - 14 * 86400_000).run();
      }
    }
  }
}

// ---------------- push subscriptions ----------------

async function subscribe(env: Env, body: any) {
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return fail(400, "bad subscription");
  if (!/^https:\/\//.test(sub.endpoint)) return fail(400, "bad endpoint");
  await env.DB.prepare(
    `INSERT INTO subscriptions (endpoint, p256dh, auth, device, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`,
  ).bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(body.device ?? "").slice(0, 80), Date.now()).run();
  return json({ ok: true });
}

// ---------------- attachments ----------------

async function upload(env: Env, req: Request) {
  const name = decodeURIComponent(req.headers.get("X-File-Name") ?? "file").slice(0, 200);
  const type = req.headers.get("Content-Type") ?? "application/octet-stream";
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_FILE) return fail(413, "file larger than 25 MB");
  const id = crypto.randomUUID().replace(/-/g, "");
  // KV metadata travels in an ASCII header, so the name is stored URI-encoded
  await env.FILES.put(`file:${id}`, buf, { metadata: { name: encodeURIComponent(name), type, size: buf.byteLength } });
  return json({ id, name, type, size: buf.byteLength });
}

async function download(env: Env, id: string) {
  const r = await env.FILES.getWithMetadata<{ name: string; type: string }>(`file:${id}`, "arrayBuffer");
  if (!r.value) return fail(404, "no such file");
  const meta = r.metadata ?? { name: "file", type: "application/octet-stream" };
  return new Response(r.value, {
    headers: {
      ...cors,
      "Content-Type": meta.type,
      "Content-Disposition": `inline; filename*=UTF-8''${meta.name}`,
      "Cache-Control": "private, max-age=86400",
    },
  });
}

// ---------------- calendars ----------------

async function feedProxy(env: Env, i: number) {
  const s = await getSettings(env);
  const f = s.feeds?.[i];
  if (!f?.url) return fail(404, "no such feed");
  const target = f.url.trim().replace(/^webcal:\/\//i, "https://");
  if (!/^https:\/\//i.test(target)) return fail(400, "feed URL must be https or webcal");
  const res = await fetch(target, { cf: { cacheTtl: 600, cacheEverything: true } } as RequestInit);
  if (!res.ok) return fail(502, `calendar server answered ${res.status}`);
  return new Response(await res.text(), { headers: { ...cors, "Content-Type": "text/calendar; charset=utf-8" } });
}

async function calendarFeed(env: Env, url: URL) {
  const m = url.pathname.match(/^\/cal\/([^/]+)\.ics$/);
  if (!m || !safeEqual(m[1], env.ICS_TOKEN ?? "")) return new Response("not found", { status: 404 });
  const s = await getSettings(env);
  const r = await env.DB.prepare("SELECT data FROM records WHERE active = 1").all<{ data: string }>();
  const ics = buildICS(r.results.map((x) => JSON.parse(x.data)), s, url.origin);
  return new Response(ics, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "max-age=300" },
  });
}

// ---------------- pairing ----------------
// A new device claims the access token with a one-time code instead of typing the token.
// 6-digit codes come from Settings on a connected device and last 10 minutes; the deploy
// workflow makes a 10-digit code that lasts 24 hours. Repeated wrong guesses lock
// claiming for 15 minutes.

const PAIR_TTL = 10 * 60_000;

async function startPairing(env: Env) {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, "0");
  const exp = Date.now() + PAIR_TTL;
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(`pair:${code}`, String(exp)).run();
  return json({ code, expires: exp });
}

async function claimPairing(env: Env, body: any) {
  const code = String(body?.code ?? "").replace(/\D/g, "");
  const now = Date.now();
  const failRow = await env.DB.prepare("SELECT v FROM meta WHERE k = 'pairfail'").first<{ v: string }>();
  const tries = failRow ? (JSON.parse(failRow.v) as { n: number; since: number }) : { n: 0, since: now };
  if (now - tries.since > 15 * 60_000) Object.assign(tries, { n: 0, since: now });
  if (tries.n >= 20) return fail(429, "too many wrong codes; try again in 15 minutes");
  const row = code.length === 6 || code.length === 10 ? await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(`pair:${code}`).first<{ v: string }>() : null;
  if (!row || Number(row.v) < now) {
    tries.n++;
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('pairfail', ?)").bind(JSON.stringify(tries)).run();
    return fail(403, "wrong or expired code");
  }
  await env.DB.prepare("DELETE FROM meta WHERE k = ?").bind(`pair:${code}`).run();
  return json({ token: env.API_TOKEN });
}
