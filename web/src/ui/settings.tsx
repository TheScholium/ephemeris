import { useEffect, useState } from "preact/hooks";
import { createProject, createSpace, fmtTime12, type Project, type Rec, type Settings, type Space } from "@ephemeris/core";
import { Icon } from "./icons";
import { SyntaxHelp } from "./quickadd";
import { api, apiBase, apiJSON, conn, connected, pairWithCode, showToast, store, syncNow, syncState, useAtom, useStore } from "../state";

const set = (patch: Partial<Settings>) => store.update<Settings>("settings", patch);

function b64uToBytes(s: string) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? "iPad" : "Mac";
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}

export async function enablePush(): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (isIOS() && !isStandalone()) throw new Error("On iPhone, add Ephemeris to the Home Screen first, then open it from there.");
    throw new Error("This browser does not support push notifications.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked. Allow them in the system settings for this app.");
  const reg = await navigator.serviceWorker.ready;
  const { key } = await apiJSON<{ key: string | null }>("/api/push/key");
  if (!key) throw new Error("The server has no push keys. Run the setup script again.");
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options.applicationServerKey;
    const same = cur && btoa(String.fromCharCode(...new Uint8Array(cur))) === btoa(String.fromCharCode(...b64uToBytes(key)));
    if (!same) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await apiJSON("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), device: deviceName() }),
  });
  return deviceName();
}

function Field({ label, children, hint }: { label: string; children: preact.ComponentChildren; hint?: preact.ComponentChildren }) {
  return (
    <div class="sf">
      <label class="sf-label">{label}</label>
      <div class="sf-ctl">{children}</div>
      {hint && <p class="sf-hint">{hint}</p>}
    </div>
  );
}

const OFFSETS: [string, number | null][] = [["Off", null], ["At the time", 0], ["5 min before", 5], ["10 min before", 10], ["15 min before", 15], ["30 min before", 30], ["1 hour before", 60], ["2 hours before", 120]];

export function SettingsView() {
  useStore();
  const c = useAtom(conn);
  const sync = useAtom(syncState);
  const s = store.settings;
  const [server, setServer] = useState(c.server);
  const [token, setToken] = useState(c.token);
  const [info, setInfo] = useState<{ icsUrl: string | null; webcalUrl: string | null } | null>(null);
  const [devices, setDevices] = useState<{ device: string; created: number }[]>([]);
  const [pushMsg, setPushMsg] = useState("");
  const [feed, setFeed] = useState({ name: "", url: "", color: "#8fa8c8" });
  const [newSpace, setNewSpace] = useState("");
  const [newProject, setNewProject] = useState("");
  const [pair, setPair] = useState<{ code: string; expires: number } | null>(null);
  const [code, setCode] = useState("");
  const zones = (Intl as any).supportedValuesOf ? ((Intl as any).supportedValuesOf("timeZone") as string[]) : [s.tz];

  useEffect(() => {
    if (!connected()) return;
    apiJSON("/api/info").then(setInfo).catch(() => setInfo(null));
    apiJSON("/api/push/devices").then(setDevices).catch(() => undefined);
  }, [c.token, c.server]);

  const pairLink = `${location.origin}${location.pathname}#/pair?server=${encodeURIComponent(apiBase())}&token=${encodeURIComponent(c.token)}`;
  const copy = (txt: string, what: string) => navigator.clipboard?.writeText(txt).then(() => showToast(`${what} copied`), () => prompt("Copy this:", txt));

  return (
    <div class="view settings">
      <header class="vh"><h1>Settings</h1></header>

      <section class="sset">
        <h2>Sync</h2>
        <p class="sf-hint">
          {sync.status === "local" && "This device keeps tasks only in this browser. Connect your server to sync the Mac, iPhone and Supernote."}
          {sync.status === "idle" && `Synced${sync.last ? " at " + new Date(sync.last).toLocaleTimeString() : ""}.`}
          {sync.status === "syncing" && "Syncing."}
          {sync.status === "offline" && "Offline. Changes are kept here and sync when you reconnect."}
          {sync.status === "error" && <span class="late-text">Sync failed: {sync.error}. Check the server address and token.</span>}
        </p>
        <Field label="Server" hint="Leave empty when this page is served by your Ephemeris server.">
          <input value={server} placeholder={location.origin} onInput={(e) => setServer(e.currentTarget.value.trim())} inputMode="url" />
        </Field>
        {!connected() && (
          <Field label="Pairing code" hint="The easiest way to connect: type a code from the deploy summary on GitHub or from another device.">
            <input id="settings-pair-code" inputMode="numeric" value={code} placeholder="00000 00000" onInput={(e) => setCode(e.currentTarget.value)} />
            <button class="btn primary" onClick={async () => {
              try {
                await pairWithCode(code, server);
                showToast("Connected");
              } catch (e: any) {
                showToast(`Could not connect: ${e.message}`);
              }
            }}>Connect with code</button>
          </Field>
        )}
        <Field label="Access token" hint="Alternative to a pairing code. Anyone with the token can read and change your tasks.">
          <input type="password" value={token} onInput={(e) => setToken(e.currentTarget.value.trim())} autoComplete="off" />
        </Field>
        <div class="row-ctl">
          <button class="btn primary" onClick={async () => {
            try {
              const base = (server || location.origin).replace(/\/+$/, "");
              const h = await fetch(base + "/api/health").then((r) => r.json());
              if (!h?.ok) throw new Error("not an Ephemeris server");
              conn.set({ server, token });
              showToast("Connected");
            } catch (e: any) {
              showToast(`Could not reach the server: ${e.message}`);
            }
          }}>Connect</button>
          {connected() && <button class="btn" onClick={() => void syncNow()}><Icon name="sync" /> Sync now</button>}
          {connected() && <button class="btn" onClick={() => {
            if (confirm("Disconnect this device? Tasks stay on this device.")) conn.set({ server: "", token: "" });
          }}>Disconnect</button>}
        </div>
        {connected() && (
          <Field label="Add another device" hint="iPhone: open the link on it (AirDrop works). Supernote: in the Ephemeris plugin, enter the server address and this 6-digit code. The code works once, for 10 minutes. The link contains your token, so treat it like a password.">
            <button class="btn" onClick={() => copy(pairLink, "Pairing link")}>Copy pairing link</button>
            <button class="btn" onClick={async () => {
              try {
                const r = await apiJSON<{ code: string; expires: number }>("/api/pair", { method: "POST" });
                setPair(r);
              } catch (e: any) {
                showToast(e.message);
              }
            }}>Show a pairing code</button>
            {pair && pair.expires > Date.now() && (
              <span class="paircode" aria-live="polite">{pair.code.slice(0, 3)} {pair.code.slice(3)}<span class="dim small"> for {apiBase().replace(/^https?:\/\//, "")}</span></span>
            )}
          </Field>
        )}
      </section>

      <section class="sset">
        <h2>Notifications</h2>
        {!connected() ? <p class="sf-hint">Notifications come from your server. Connect it first.</p> : (
          <>
            {isIOS() && !isStandalone() && (
              <p class="sf-hint warn">On iPhone, notifications work only in the Home Screen app: tap Share, then Add to Home Screen, then open Ephemeris from the Home Screen and return here.</p>
            )}
            <div class="row-ctl wrap">
              <button class="btn primary" onClick={async () => {
                try {
                  const d = await enablePush();
                  setPushMsg(`Notifications are on for this ${d}.`);
                  apiJSON("/api/push/devices").then(setDevices);
                } catch (e: any) {
                  setPushMsg(e.message);
                }
              }}><Icon name="bell" /> Turn on for this device</button>
              <button class="btn" onClick={async () => {
                try {
                  const r = await apiJSON<{ sent: number }>("/api/push/test", { method: "POST" });
                  setPushMsg(r.sent ? `Test sent to ${r.sent} device${r.sent > 1 ? "s" : ""}.` : "No device has notifications on yet.");
                } catch (e: any) {
                  setPushMsg(e.message);
                }
              }}>Send a test</button>
            </div>
            {pushMsg && <p class="sf-hint">{pushMsg}</p>}
            {devices.length > 0 && <p class="sf-hint">Devices: {devices.map((d) => d.device || "unnamed").join(", ")}</p>}
          </>
        )}
        <Field label="Daily summary">
          <label class="inline"><input type="checkbox" checked={s.digestEnabled} onChange={(e) => set({ digestEnabled: e.currentTarget.checked })} /> Send at</label>
          <input type="time" value={s.digestTime} onChange={(e) => e.currentTarget.value && set({ digestTime: e.currentTarget.value })} />
        </Field>
        <Field label="Tasks with a planned time">
          <select value={String(s.autoPlannedOffset)} onChange={(e) => set({ autoPlannedOffset: e.currentTarget.value === "null" ? null : Number(e.currentTarget.value) })}>
            {OFFSETS.map(([l, v]) => <option value={String(v)}>{l}</option>)}
          </select>
        </Field>
        <Field label="Deadlines with a time">
          <select value={String(s.autoDueOffset)} onChange={(e) => set({ autoDueOffset: e.currentTarget.value === "null" ? null : Number(e.currentTarget.value) })}>
            {OFFSETS.map(([l, v]) => <option value={String(v)}>{l}</option>)}
          </select>
        </Field>
        <Field label="Evening before a deadline" hint="Not sent when the task is already planned before the deadline day.">
          <label class="inline"><input type="checkbox" checked={!!s.dueEveTime} onChange={(e) => set({ dueEveTime: e.currentTarget.checked ? "20:00" : null })} /> Remind at</label>
          {s.dueEveTime && <input type="time" value={s.dueEveTime} onChange={(e) => e.currentTarget.value && set({ dueEveTime: e.currentTarget.value })} />}
        </Field>
        <Field label="Reminders on days without a time" hint={`Used when a reminder points at a date that has no time (now ${fmtTime12(s.allDayTime)}).`}>
          <input type="time" value={s.allDayTime} onChange={(e) => e.currentTarget.value && set({ allDayTime: e.currentTarget.value })} />
        </Field>
      </section>

      <section class="sset">
        <h2>Time</h2>
        <Field label="Time zone" hint="Reminders are sent in this zone.">
          <select value={s.tz} onChange={(e) => set({ tz: e.currentTarget.value })}>
            {(zones.includes(s.tz) ? zones : [s.tz, ...zones]).map((z) => <option value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
        </Field>
        <Field label="Week starts on">
          <select value={String(s.weekStart)} onChange={(e) => set({ weekStart: Number(e.currentTarget.value) })}>
            <option value="1">Monday</option>
            <option value="0">Sunday</option>
          </select>
        </Field>
        <Field label="Working day" hint="Sets the calendar hours and the length of the load scale on Today.">
          <input type="time" value={s.dayStart} onChange={(e) => e.currentTarget.value && set({ dayStart: e.currentTarget.value })} />
          <span>to</span>
          <input type="time" value={s.dayEnd} onChange={(e) => e.currentTarget.value && set({ dayEnd: e.currentTarget.value })} />
        </Field>
      </section>

      <section class="sset">
        <h2>Calendars</h2>
        <Field label="Show your plan in Calendar" hint="Subscribe to this address in Apple Calendar (File, New Calendar Subscription) or Google Calendar (Other calendars, From URL). Planned tasks appear as events; Apple Calendar refreshes it every few minutes, Google only a few times a day.">
          {info?.icsUrl ? (
            <div class="row-ctl wrap">
              <button class="btn" onClick={() => copy(info.icsUrl!, "Calendar address")}>Copy address</button>
              {info.webcalUrl && <a class="btn" href={info.webcalUrl}>Open in Calendar</a>}
            </div>
          ) : <span class="dim">Connect the server to get the address.</span>}
        </Field>
        <Field label="Deadlines in the feed">
          <label class="inline"><input type="checkbox" checked={s.icsIncludeDue} onChange={(e) => set({ icsIncludeDue: e.currentTarget.checked })} /> Add deadlines as all-day events</label>
        </Field>
        <Field label="Show calendars beside tasks" hint="Paste a secret iCal address. In Google Calendar: Settings, select the calendar, Integrate calendar, Secret address in iCal format. The server fetches it, so it stays private to you.">
          <div class="feeds">
            {(s.feeds ?? []).map((f, i) => (
              <div class="feed">
                <i class="swatch" style={{ background: f.color }} />
                <span>{f.name}</span>
                <span class="dim small ellipsis">{f.url.replace(/^(https?|webcal):\/\//, "").slice(0, 40)}</span>
                <button class="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => set({ feeds: s.feeds.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button>
              </div>
            ))}
            <div class="row-ctl wrap">
              <input placeholder="Name (Classes)" value={feed.name} onInput={(e) => setFeed({ ...feed, name: e.currentTarget.value })} />
              <input placeholder="https://calendar.google.com/calendar/ical/..." value={feed.url} onInput={(e) => setFeed({ ...feed, url: e.currentTarget.value.trim() })} inputMode="url" />
              <input type="color" value={feed.color} onInput={(e) => setFeed({ ...feed, color: e.currentTarget.value })} aria-label="Color" />
              <button class="btn" onClick={() => {
                if (!/^(https|webcal):\/\//i.test(feed.url)) return showToast("Use an https:// or webcal:// address");
                set({ feeds: [...(s.feeds ?? []), { name: feed.name || "Calendar", url: feed.url, color: feed.color }] });
                setFeed({ name: "", url: "", color: "#8fa8c8" });
              }}>Add</button>
            </div>
          </div>
        </Field>
      </section>

      <section class="sset">
        <h2>Spaces and projects</h2>
        <p class="sf-hint">A space is a large area of life (School, Lab, Personal). Projects sit inside a space. Tags cut across both.</p>
        {store.spaces.map((sp) => (
          <div class="feed">
            <Icon name="space" />
            <input value={sp.name} onChange={(e) => store.update<Space>(sp.id, { name: e.currentTarget.value.trim() || sp.name })} aria-label="Space name" />
            <button class="link-btn danger" onClick={() => {
              if (confirm(`Delete space "${sp.name}"? Its projects and tasks stay.`)) store.update<Space>(sp.id, { deleted: true });
            }}>Delete</button>
          </div>
        ))}
        <div class="row-ctl">
          <input placeholder="New space" value={newSpace} onInput={(e) => setNewSpace(e.currentTarget.value)} />
          <button class="btn" onClick={() => {
            if (newSpace.trim()) createSpace(store, newSpace.trim());
            setNewSpace("");
          }}>Add space</button>
        </div>
        {store.projects.map((p) => (
          <div class="feed">
            <input type="color" value={p.color} onInput={(e) => store.update<Project>(p.id, { color: e.currentTarget.value })} aria-label="Project color" />
            <input value={p.name} onChange={(e) => store.update<Project>(p.id, { name: e.currentTarget.value.trim() || p.name })} aria-label="Project name" />
            <select value={p.spaceId ?? ""} onChange={(e) => store.update<Project>(p.id, { spaceId: e.currentTarget.value || null })} aria-label="Space">
              <option value="">No space</option>
              {store.spaces.map((sp) => <option value={sp.id}>{sp.name}</option>)}
            </select>
            <button class="link-btn" onClick={() => store.update<Project>(p.id, { archived: !p.archived })}>{p.archived ? "Unarchive" : "Archive"}</button>
          </div>
        ))}
        <div class="row-ctl">
          <input placeholder="New project" value={newProject} onInput={(e) => setNewProject(e.currentTarget.value)} />
          <button class="btn" onClick={() => {
            if (newProject.trim()) createProject(store, newProject.trim());
            setNewProject("");
          }}>Add project</button>
        </div>
      </section>

      <section class="sset">
        <h2>Data</h2>
        <div class="row-ctl wrap">
          <button class="btn" onClick={() => {
            const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), records: store.dump() }, null, 1)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `ephemeris-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
          }}>Export backup</button>
          <label class="btn file-btn">Import backup
            <input type="file" accept="application/json" onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                const recs = (data.records ?? data) as Rec[];
                store.applyRemote(recs);
                recs.forEach((r) => store.dirty.add(r.id));
                showToast(`Imported ${recs.length} records`);
                void syncNow();
              } catch (err: any) {
                showToast(`Import failed: ${err.message}`);
              }
            }} />
          </label>
        </div>
      </section>

      <section class="sset">
        <h2>Quick add</h2>
        <SyntaxHelp />
        <h2>Keyboard (Mac)</h2>
        <table class="keys"><tbody>
          <tr><td><kbd>n</kbd></td><td>new task</td><td><kbd>/</kbd></td><td>find</td></tr>
          <tr><td><kbd>j</kbd> <kbd>k</kbd></td><td>move down, up</td><td><kbd>Enter</kbd></td><td>open task</td></tr>
          <tr><td><kbd>x</kbd></td><td>select</td><td><kbd>d</kbd></td><td>done</td></tr>
          <tr><td><kbd>t</kbd></td><td>plan for today</td><td><kbd>Esc</kbd></td><td>close, clear selection</td></tr>
          <tr><td><kbd>1</kbd> to <kbd>5</kbd></td><td>Today, Upcoming, Calendar, Inbox, Logbook</td><td>Cmd-click, Shift-click</td><td>select several</td></tr>
        </tbody></table>
      </section>
    </div>
  );
}

export { api };
