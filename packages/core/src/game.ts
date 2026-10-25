// Sisyphus: the game layer. Completed work grants experience to traits.
//
// Everything here is derived from GameEvent records (see types.ts). Events are
// append-only and have deterministic ids, so two devices that complete the same
// task offline write the SAME event and the merge keeps one. Levels are computed
// from events on demand, so the level curve can change without losing history.

import { addDays, todayIn, type ISODate } from "./dates";
import type { Store } from "./store";
import { stableId } from "./sync";
import { DEFAULT_TRAIT, TRAITS, type EventSource, type GameEvent, type Habit, type Settings, type Task, type Trait } from "./types";

// ---------- level curve ----------

/** Total experience needed to reach level n (level 0 needs none). */
export const xpForLevel = (n: number): number => (n <= 0 ? 0 : Math.ceil(50 * Math.pow(n, 1.5)));

/** Highest level whose threshold is at or below xp. */
export function levelFromXp(xp: number): number {
  if (!(xp > 0)) return 0;
  let n = Math.max(0, Math.floor(Math.pow(xp / 50, 2 / 3)));
  while (xpForLevel(n + 1) <= xp) n++;
  while (n > 0 && xpForLevel(n) > xp) n--;
  return n;
}

// ---------- experience values ----------

/** Experience each check-in grants to each of the ritual's traits. */
export const RITUAL_XP = 5;

/**
 * Experience a finished task grants to each of its traits. A task with no estimate
 * gives 10. With an estimate, the value follows the time (one point per 6 minutes,
 * kept between 5 and 30), so many tiny tasks do not beat real work.
 */
export function taskXp(t: Pick<Task, "estimate">): number {
  if (!t.estimate || t.estimate <= 0) return 10;
  return Math.min(30, Math.max(5, Math.round(t.estimate / 6)));
}

// ---------- traits of a task or ritual ----------

const normTag = (tag: string) => tag.trim().replace(/^#/, "").toLowerCase();
const ordered = (set: Set<Trait>): Trait[] => TRAITS.filter((t) => set.has(t));
const isTrait = (x: unknown): x is Trait => (TRAITS as readonly string[]).includes(x as string);

/** The traits that a list of tags adds, through the tag map in Settings. */
export function tagTraitsOf(tags: string[], settings: Pick<Settings, "tagTraits">): Trait[] {
  const set = new Set<Trait>();
  const map = settings.tagTraits ?? {};
  for (const tag of tags ?? []) for (const tr of map[normTag(tag)] ?? []) if (isTrait(tr)) set.add(tr);
  return ordered(set);
}

/** The traits a task trains: its own, plus those added by its tags. Empty means DEFAULT_TRAIT. */
export function traitsOfTask(t: Pick<Task, "traits" | "tags">, settings: Pick<Settings, "tagTraits">): Trait[] {
  const set = new Set<Trait>((t.traits ?? []).filter(isTrait));
  for (const tr of tagTraitsOf(t.tags, settings)) set.add(tr);
  return set.size ? ordered(set) : [DEFAULT_TRAIT];
}

export function traitsOfRitual(h: Pick<Habit, "traits">): Trait[] {
  const set = new Set<Trait>((h.traits ?? []).filter(isTrait));
  return set.size ? ordered(set) : [DEFAULT_TRAIT];
}

/** Map a tag to traits (replaces the old mapping; an empty list removes it). */
export function setTagTraits(store: Store, tag: string, traits: Trait[]) {
  const key = normTag(tag);
  if (!key) return;
  const next: Record<string, Trait[]> = { ...(store.settings.tagTraits ?? {}) };
  const clean = ordered(new Set(traits.filter(isTrait)));
  if (clean.length) next[key] = clean;
  else delete next[key];
  store.update<Settings>("settings", { tagTraits: next });
}

// ---------- writing events ----------

interface Grant {
  source: EventSource;
  sourceId: string;
  /** distinguishes several grants from one source (device and index for check-ins) */
  part?: string;
  trait: Trait;
  xp: number;
  label: string;
  day: ISODate;
}

/** Write one event. If it exists and is deleted, bring it back; if it is live, leave it. */
function grant(store: Store, g: Grant): GameEvent {
  const id = stableId(`event:${g.source}:${g.sourceId}:${g.part ?? ""}:${g.trait}`);
  const cur = store.get<GameEvent>(id);
  if (cur) {
    if (cur.deleted) store.update<GameEvent>(id, { deleted: false, xp: g.xp, label: g.label });
    return store.get<GameEvent>(id)!;
  }
  return store.insert<GameEvent>({
    id,
    kind: "event",
    _c: {},
    createdAt: new Date().toISOString(),
    at: new Date().toISOString(),
    day: g.day,
    trait: g.trait,
    xp: g.xp,
    source: g.source,
    sourceId: g.sourceId,
    label: g.label,
    deleted: false,
  });
}

/** Mark every live event of a source as deleted (the work was undone). */
export function revokeEvents(store: Store, source: EventSource, sourceId: string) {
  store.batch(() => {
    for (const e of store.events) {
      if (e.source === source && e.sourceId === sourceId) store.update<GameEvent>(e.id, { deleted: true });
    }
  });
}

/** Grant experience for a task that was just completed. */
export function awardTask(store: Store, t: Task): GameEvent[] {
  const day = todayIn(store.settings.tz);
  const xp = taskXp(t);
  return store.batch(() =>
    traitsOfTask(t, store.settings).map((trait) =>
      grant(store, { source: "task", sourceId: t.id, trait, xp, label: t.title || "Task", day }),
    ),
  );
}

/**
 * Grant experience for check-in number `index` made on this device for `day`.
 * The device is part of the event id, so check-ins from two devices never collide.
 */
export function awardRitual(store: Store, h: Habit, day: ISODate, index: number): GameEvent[] {
  const part = `${store.meta.node}:${day}:${index}`;
  return store.batch(() =>
    traitsOfRitual(h).map((trait) =>
      grant(store, { source: "ritual", sourceId: h.id, part, trait, xp: RITUAL_XP, label: h.name, day }),
    ),
  );
}

/**
 * Make the events of one ritual day match a new total of n check-ins. Used when a
 * day is edited directly. Events come back under the same ids if the count rises again,
 * so toggling a day on and off does not create experience.
 */
export function reconcileRitualDay(store: Store, h: Habit, day: ISODate, n: number) {
  store.batch(() => {
    for (const e of store.events) {
      if (e.source === "ritual" && e.sourceId === h.id && e.day === day) store.update<GameEvent>(e.id, { deleted: true });
    }
    for (let i = 1; i <= n; i++) awardRitual(store, h, day, i);
  });
}

// ---------- reading ----------

export interface TraitLine {
  trait: Trait;
  xp: number;
  level: number;
  /** experience gained inside the current level */
  into: number;
  /** experience that the current level spans */
  span: number;
  /** progress in the current level, 0..1 */
  frac: number;
  /** experience gained in the recent window */
  recent: number;
}

export interface RecentLine {
  day: ISODate;
  source: EventSource;
  label: string;
  xp: number;
  traits: Trait[];
}

export interface CharacterSheet {
  today: ISODate;
  windowDays: number;
  traits: TraitLine[];
  totalLevel: number;
  totalXp: number;
  recent: RecentLine[];
}

export function traitTotals(events: GameEvent[]): Record<Trait, number> {
  const out = Object.fromEntries(TRAITS.map((t) => [t, 0])) as Record<Trait, number>;
  for (const e of events) if (e.trait in out) out[e.trait] += Math.max(0, e.xp || 0);
  return out;
}

export function characterSheet(store: Store, today: ISODate, windowDays = 7, maxRecent = 12): CharacterSheet {
  const events = store.events;
  const totals = traitTotals(events);
  const since = addDays(today, -(windowDays - 1));
  const inWindow = events.filter((e) => e.day >= since && e.day <= today);
  const recentByTrait = traitTotals(inWindow);

  const traits: TraitLine[] = TRAITS.map((trait) => {
    const xp = totals[trait];
    const level = levelFromXp(xp);
    const base = xpForLevel(level);
    const span = xpForLevel(level + 1) - base;
    const into = xp - base;
    return { trait, xp, level, into, span, frac: span > 0 ? into / span : 0, recent: recentByTrait[trait] };
  });

  // One line per source item and day, so a task that trains three traits shows once.
  const groups = new Map<string, RecentLine & { at: string }>();
  for (const e of inWindow) {
    const key = `${e.day}|${e.source}|${e.sourceId}`;
    const g = groups.get(key);
    if (g) {
      g.xp += e.xp;
      if (!g.traits.includes(e.trait)) g.traits.push(e.trait);
      if (e.at > g.at) g.at = e.at;
    } else groups.set(key, { day: e.day, source: e.source, label: e.label, xp: e.xp, traits: [e.trait], at: e.at });
  }
  const recent = [...groups.values()]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, maxRecent)
    .map(({ at: _at, ...r }) => ({ ...r, traits: TRAITS.filter((t) => r.traits.includes(t)) }));

  return {
    today,
    windowDays,
    traits,
    totalLevel: traits.reduce((n, t) => n + t.level, 0),
    totalXp: traits.reduce((n, t) => n + t.xp, 0),
    recent,
  };
}

// ---------- text rendering (also used by the Supernote plugin) ----------

export const TRAIT_LABEL: Record<Trait, string> = {
  peace: "Peace",
  constitution: "Constitution",
  wisdom: "Wisdom",
  charisma: "Charisma",
  presentation: "Presentation",
};

export function bar(frac: number, width = 12): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

export function renderSheetText(s: CharacterSheet): string {
  const pad = (x: string, n: number) => x + " ".repeat(Math.max(0, n - x.length));
  const lines: string[] = [];
  lines.push(`CHARACTER SHEET  ${s.today}`);
  lines.push(`Total level ${s.totalLevel}   Experience ${s.totalXp}`);
  lines.push("");
  for (const t of s.traits) {
    const recent = t.recent ? `  +${t.recent} this week` : "";
    lines.push(`${pad(TRAIT_LABEL[t.trait], 13)} Lv ${pad(String(t.level), 3)} ${bar(t.frac)} ${t.into}/${t.span}${recent}`);
  }
  lines.push("");
  lines.push(`RECENT (${s.windowDays} days)`);
  if (!s.recent.length) lines.push("  Nothing yet. Finish a task or check in a ritual.");
  for (const r of s.recent) lines.push(`  ${r.day.slice(5)}  +${r.xp}  ${r.label}  [${r.traits.map((t) => TRAIT_LABEL[t]).join(", ")}]`);
  return lines.join("\n");
}
