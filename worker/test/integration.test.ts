// Runs against a live server: EPH_URL=http://localhost:8787 EPH_TOKEN=devtoken npx vitest run test/integration.test.ts
import { describe, expect, it } from "vitest";
import { Store, memoryPersistence, quickAdd, completeTask, type SyncRequest, type Task, type Settings } from "@ephemeris/core";

const URL_ = process.env.EPH_URL;
const TOKEN = process.env.EPH_TOKEN ?? "";
const run = URL_ ? describe : describe.skip;

const transport = (token = TOKEN) => async (req: SyncRequest) => {
  const r = await fetch(`${URL_}/api/sync`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(req) });
  if (!r.ok) throw new Error(`sync ${r.status}`);
  return r.json();
};
const mk = async () => { const s = new Store(memoryPersistence()); await s.init(); return s; };
const ctx = { today: "2026-10-21", nowMinutes: 600 };

run("live server", () => {
  it("rejects a wrong token", async () => {
    await expect(transport("nope")({ since: 0, changes: [] })).rejects.toThrow("401");
  });

  it("syncs two devices and converges", async () => {
    const mac = await mk();
    const phone = await mk();
    mac.update<Settings>("settings", { tz: "America/New_York" });
    const t = quickAdd(mac, `Integration ${Date.now()} every mon due fri #it +Testing`, ctx);
    await mac.sync(transport());
    await phone.sync(transport());
    expect(phone.get<Task>(t.id)?.title).toBe(t.title);
    expect(phone.projects.some((p) => p.name === "Testing")).toBe(true);
    expect(phone.settings.tz).toBe("America/New_York");
    completeTask(phone, t.id, "2026-10-22");
    await phone.sync(transport());
    await mac.sync(transport());
    expect(mac.get<Task>(t.id)?.status).toBe("done");
    expect(mac.tasks.filter((x) => x.seriesId === t.seriesId && x.status === "open")).toHaveLength(1);
  });

  it("stores alarms and serves the calendar feed", async () => {
    const s = await mk();
    s.update<Settings>("settings", { tz: "America/New_York" });
    const soon = new Date(Date.now() + 3 * 3600_000);
    const hh = soon.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
    const day = soon.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const t = quickAdd(s, `Feed check ${day} at ${hh} for 45m`, { today: day, nowMinutes: 0 });
    await s.sync(transport());
    await new Promise((r) => setTimeout(r, 500));
    const ics = await (await fetch(`${URL_}/cal/devics.ics`)).text();
    expect(ics).toContain(`UID:${t.id}-plan@ephemeris`);
    expect((await fetch(`${URL_}/cal/wrong.ics`)).status).toBe(404);
  });

  it("uploads and downloads an attachment", async () => {
    const up = await fetch(`${URL_}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain", "X-File-Name": encodeURIComponent("notes ü.txt") }, body: "hello" });
    const meta = await up.json() as any;
    expect(meta.name).toBe("notes ü.txt");
    const down = await fetch(`${URL_}/api/files/${meta.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await down.text()).toBe("hello");
  });
});
