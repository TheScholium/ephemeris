/**
 * Ephemeris for Supernote: today's plan and deadlines, check-off, quick add.
 * Built for e-ink: black on white, no animation, large targets, few redraws.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { PluginManager } from "sn-plugin-lib";
import {
  addDays, completeTask, describeRule, fmtDuration, fmtTime12, inbox, longDate, parseTask, quickAdd, relDate,
  skipOccurrence, todayView, upcoming, updateTask, type Task,
} from "./src/core";
import { init, loadConfig, nowMinutes, pair, saveConfig, store, sync, todayLocal, type Config } from "./src/client";

type Tab = "today" | "week" | "inbox";

export default function App(): React.JSX.Element {
  const [config, setConfig] = useState<Config | null | undefined>(undefined);
  const [, setVersion] = useState(0);
  const [status, setStatus] = useState("");
  const [tab, setTab] = useState<Tab>("today");
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSync = useCallback(async (c: Config | null | undefined) => {
    if (!c || !c.token) return;
    setStatus("Syncing");
    try {
      await sync(c);
      const t = new Date();
      setStatus(`Synced ${fmtTime12(`${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`)}`);
    } catch (e: any) {
      setStatus(`Not synced: ${e?.message ?? e}. Changes are kept on this device.`);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await init();
      const c = await loadConfig();
      setConfig(c);
      setVersion((v) => v + 1);
      void doSync(c);
    })();
    const unsub = store.subscribe(() => {
      setVersion((v) => v + 1);
      if (store.dirty.size) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => loadConfig().then(doSync), 800);
      }
    });
    const life = PluginManager.registerPluginLifeListener({
      onMsg(msg: any) {
        if (msg?.state === 2) loadConfig().then(doSync); // plugin brought to the front
      },
    });
    return () => {
      unsub();
      life?.remove?.();
    };
  }, [doSync]);

  if (config === undefined) return <View style={s.page}><Text style={s.dim}>Opening</Text></View>;
  if (!config) return <PairScreen onPaired={(c) => { setConfig(c); void doSync(c); }} onLocal={() => setConfig({ server: "", token: "" })} />;

  const today = todayLocal();
  return (
    <View style={s.page}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.h1}>{tab === "today" ? "Today" : tab === "week" ? "Next 7 days" : "Inbox"}</Text>
          <Text style={s.dim}>{longDate(today)}{status ? `   ${status}` : ""}</Text>
        </View>
        {!!config.token && <Btn label="Sync" onPress={() => doSync(config)} />}
        <Btn label="Close" onPress={() => PluginManager.closePluginView()} />
      </View>

      <QuickAdd tab={tab} today={today} />

      <View style={s.tabs}>
        {(["today", "week", "inbox"] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => { setTab(t); setOpen(null); }} style={[s.tab, tab === t && s.tabOn]}>
            <Text style={[s.tabText, tab === t && s.tabTextOn]}>{t === "today" ? "Today" : t === "week" ? "Week" : "Inbox"}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
        {tab === "today" && <TodayList today={today} open={open} setOpen={setOpen} />}
        {tab === "week" && <WeekList today={today} open={open} setOpen={setOpen} />}
        {tab === "inbox" && <Rows tasks={inbox(store.tasks)} today={today} open={open} setOpen={setOpen} empty="Inbox is clear." />}
        {!config.token && (
          <Pressable onPress={async () => { await saveConfig(null); setConfig(null); }}>
            <Text style={[s.dim, { marginTop: 30 }]}>Tasks are only on this Supernote. Tap here to connect your server.</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

// ---------- pairing ----------

function PairScreen({ onPaired, onLocal }: { onPaired: (c: Config) => void; onLocal: () => void }) {
  const [server, setServer] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <View style={s.page}>
      <View style={s.header}>
        <Text style={[s.h1, { flex: 1 }]}>Connect Ephemeris</Text>
        <Btn label="Close" onPress={() => PluginManager.closePluginView()} />
      </View>
      <Text style={s.body}>On your Mac or iPhone, open Ephemeris, go to Settings, and tap "Show a pairing code". Then type the server address and the code here.</Text>
      <Text style={s.label}>Server address</Text>
      <TextInput style={s.input} value={server} onChangeText={setServer} placeholder="ephemeris.yourname.workers.dev"
        autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Text style={s.label}>Pairing code</Text>
      <TextInput style={[s.input, { letterSpacing: 6, fontSize: 32 }]} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
        placeholder="000000" keyboardType="number-pad" maxLength={6} />
      {!!err && <Text style={s.err}>{err}</Text>}
      <View style={{ flexDirection: "row", marginTop: 20 }}>
        <Btn label={busy ? "Connecting" : "Connect"} strong onPress={async () => {
          if (busy) return;
          setBusy(true);
          setErr("");
          try {
            onPaired(await pair(server, code));
          } catch (e: any) {
            setErr(String(e?.message ?? e));
          } finally {
            setBusy(false);
          }
        }} />
        <Btn label="Use without a server" onPress={async () => { await saveConfig({ server: "", token: "" }); onLocal(); }} />
      </View>
    </View>
  );
}

// ---------- quick add ----------

function QuickAdd({ tab, today }: { tab: Tab; today: string }) {
  const [text, setText] = useState("");
  const ctx = useMemo(() => ({ today, nowMinutes: nowMinutes(), weekStart: store.settings.weekStart }), [today, text]);
  const p = text.trim() ? parseTask(text, ctx, store.projects.map((x) => x.name)) : null;
  const add = () => {
    if (!text.trim()) return;
    quickAdd(store, text, ctx, tab === "today" ? { planned: today } : {});
    setText("");
  };
  const bits: string[] = [];
  if (p) {
    if (p.planned) bits.push(`plan ${relDate(p.planned, today)}${p.plannedTime ? " " + fmtTime12(p.plannedTime) : ""}`);
    if (p.due) bits.push(`due ${relDate(p.due, today)}${p.dueTime ? " " + fmtTime12(p.dueTime) : ""}`);
    if (p.estimate) bits.push(fmtDuration(p.estimate));
    if (p.recurrence) bits.push(describeRule(p.recurrence).toLowerCase());
    if (p.project) bits.push(`+${p.project}`);
    p.tags.forEach((t) => bits.push(`#${t}`));
  }
  return (
    <View style={s.qa}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <TextInput style={[s.input, { flex: 1, marginRight: 10 }]} value={text} onChangeText={setText} onSubmitEditing={add}
          placeholder="New task: read ch. 3 tomorrow 9am for 1h due fri" returnKeyType="done" blurOnSubmit={false} />
        <Btn label="Add" strong onPress={add} />
      </View>
      {p && <Text style={s.dim}>{p.title || "Untitled"}{bits.length ? ":  " + bits.join(",  ") : ""}</Text>}
    </View>
  );
}

// ---------- lists ----------

interface ListProps { today: string; open: string | null; setOpen: (id: string | null) => void }

function TodayList({ today, open, setOpen }: ListProps) {
  const v = todayView(store.tasks, today);
  const props = { today, open, setOpen };
  const nothing = !v.overdue.length && !v.planned.length && !v.dueToday.length && !v.carried.length && !v.needsPlan.length;
  return (
    <View>
      {v.load > 0 && <Text style={s.dim}>{fmtDuration(v.load)} of planned work{v.loadDone ? `, ${fmtDuration(v.loadDone)} done` : ""}</Text>}
      {nothing && <Text style={s.empty}>Nothing planned or due today.</Text>}
      <Group title="Overdue" tasks={v.overdue} {...props} />
      <Group title="Due today" tasks={v.dueToday} {...props} />
      <Group title="Planned" tasks={v.planned} {...props} />
      <Group title="Carried over" tasks={v.carried} {...props} />
      <Group title="Needs a plan" tasks={v.needsPlan} {...props} />
      <Group title="Done today" tasks={v.doneToday} {...props} />
    </View>
  );
}

function WeekList({ today, open, setOpen }: ListProps) {
  const days = upcoming(store.tasks, addDays(today, 1), 7);
  return (
    <View>
      {days.map((d) => (
        <View key={d.date}>
          <Text style={s.group}>{relDate(d.date, today) === "Tomorrow" ? "Tomorrow" : longDate(d.date)}{d.load ? `   ${fmtDuration(d.load)}` : ""}</Text>
          {!d.planned.length && !d.deadlines.length && <Text style={s.emptySmall}>Nothing planned</Text>}
          <Rows tasks={d.planned} today={today} day={d.date} open={open} setOpen={setOpen} />
          <Rows tasks={d.deadlines} today={today} day={d.date} open={open} setOpen={setOpen} marker />
        </View>
      ))}
    </View>
  );
}

function Group({ title, tasks, ...rest }: { title: string; tasks: Task[] } & ListProps) {
  if (!tasks.length) return null;
  return (
    <View>
      <Text style={s.group}>{title}  <Text style={s.dim}>{tasks.length}</Text></Text>
      <Rows tasks={tasks} day={rest.today} {...rest} />
    </View>
  );
}

function Rows({ tasks, today, day, open, setOpen, marker, empty }: { tasks: Task[]; day?: string; marker?: boolean; empty?: string } & ListProps) {
  if (!tasks.length) return empty ? <Text style={s.empty}>{empty}</Text> : null;
  return <View>{tasks.map((t) => <Row key={t.id + (marker ? "m" : "")} t={t} today={today} day={day} marker={marker} open={open === t.id} toggle={() => setOpen(open === t.id ? null : t.id)} />)}</View>;
}

function Row({ t, today, day, marker, open, toggle }: { t: Task; today: string; day?: string; marker?: boolean; open: boolean; toggle: () => void }) {
  const done = t.status !== "open";
  const meta: string[] = [];
  if (marker) meta.push(`deadline; planned ${t.planned ? relDate(t.planned, today) : "for no day"}`);
  if (t.plannedTime && t.planned === day) meta.push(fmtTime12(t.plannedTime));
  else if (t.planned && t.planned !== day && !marker) meta.push(`plan ${relDate(t.planned, today)}`);
  if (t.estimate) meta.push(fmtDuration(t.estimate));
  if (t.due && !marker) meta.push(t.due < today ? `due ${relDate(t.due, today)}, late` : `due ${relDate(t.due, today)}${t.dueTime ? " " + fmtTime12(t.dueTime) : ""}`);
  if (t.recurrence) meta.push("repeats");
  if (t.tags.length) meta.push(t.tags.map((x) => "#" + x).join(" "));
  return (
    <View style={s.row}>
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <Pressable hitSlop={12} style={[s.box, done && s.boxOn]} accessibilityLabel={done ? "Mark not done" : "Mark done"}
          onPress={() => (done ? updateTask(store, t.id, { status: "open", completedAt: null }) : completeTask(store, t.id, today))}>
          {done && <Text style={s.boxMark}>✓</Text>}
        </Pressable>
        <Pressable style={{ flex: 1 }} onPress={toggle}>
          <Text style={[s.title, done && s.titleDone, marker && s.titleMarker]}>{t.title}</Text>
          {meta.length > 0 && <Text style={s.meta}>{meta.join(",  ")}</Text>}
        </Pressable>
      </View>
      {open && !done && (
        <View style={s.actions}>
          <Btn small label="Today" onPress={() => updateTask(store, t.id, { planned: today })} />
          <Btn small label="Tomorrow" onPress={() => updateTask(store, t.id, { planned: addDays(today, 1) })} />
          <Btn small label="Next week" onPress={() => updateTask(store, t.id, { planned: addDays(today, 7) })} />
          {!!t.planned && <Btn small label="Unplan" onPress={() => updateTask(store, t.id, { planned: null, plannedTime: null })} />}
          {!!t.recurrence && <Btn small label="Skip this one" onPress={() => skipOccurrence(store, t.id, today)} />}
        </View>
      )}
    </View>
  );
}

function Btn({ label, onPress, strong, small }: { label: string; onPress: () => void; strong?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[s.btn, strong && s.btnStrong, small && s.btnSmall]}>
      <Text style={[s.btnText, strong && s.btnTextStrong, small && { fontSize: 20 }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#ffffff", paddingHorizontal: 36, paddingTop: 28 },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  h1: { fontSize: 40, color: "#000", fontFamily: "serif" },
  dim: { fontSize: 20, color: "#555", marginTop: 4 },
  body: { fontSize: 24, color: "#000", lineHeight: 34, marginBottom: 20 },
  label: { fontSize: 22, color: "#000", marginTop: 16, marginBottom: 6 },
  err: { fontSize: 22, color: "#000", marginTop: 12, fontWeight: "700" },
  input: { borderWidth: 2, borderColor: "#000", borderRadius: 6, paddingHorizontal: 14, paddingVertical: 10, fontSize: 24, color: "#000" },
  qa: { marginBottom: 12 },
  tabs: { flexDirection: "row", borderBottomWidth: 2, borderColor: "#000", marginBottom: 6 },
  tab: { paddingVertical: 10, paddingHorizontal: 22, marginBottom: -2 },
  tabOn: { borderBottomWidth: 6, borderColor: "#000" },
  tabText: { fontSize: 24, color: "#555" },
  tabTextOn: { color: "#000", fontWeight: "700" },
  group: { fontSize: 26, color: "#000", fontStyle: "italic", marginTop: 22, marginBottom: 4, fontFamily: "serif" },
  empty: { fontSize: 22, color: "#555", marginTop: 24, fontStyle: "italic" },
  emptySmall: { fontSize: 20, color: "#777", fontStyle: "italic", marginVertical: 4 },
  row: { borderBottomWidth: 1, borderColor: "#999", paddingVertical: 14 },
  box: { width: 38, height: 38, borderWidth: 3, borderColor: "#000", borderRadius: 4, marginRight: 18, marginTop: 2, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: "#000" },
  boxMark: { color: "#fff", fontSize: 26, lineHeight: 30 },
  title: { fontSize: 27, color: "#000", lineHeight: 36 },
  titleDone: { color: "#777", textDecorationLine: "line-through" },
  titleMarker: { fontStyle: "italic", color: "#333" },
  meta: { fontSize: 20, color: "#444", marginTop: 2 },
  actions: { flexDirection: "row", flexWrap: "wrap", marginTop: 12, marginLeft: 56 },
  btn: { borderWidth: 2, borderColor: "#000", borderRadius: 6, paddingHorizontal: 18, paddingVertical: 8, marginLeft: 10, marginBottom: 8 },
  btnStrong: { backgroundColor: "#000" },
  btnSmall: { paddingHorizontal: 12, paddingVertical: 6, marginLeft: 0, marginRight: 10 },
  btnText: { fontSize: 22, color: "#000" },
  btnTextStrong: { color: "#fff", fontWeight: "700" },
});
