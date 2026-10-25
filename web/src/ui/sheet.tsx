// Character sheet: levels for each trait, what trained them lately, and which tags add which traits.
// Text first. The Universe view comes later and sits on top of the same events.

import { TRAITS, TRAIT_LABEL, characterSheet, longDate, relDate, setTagTraits, tagCounts, type Trait } from "@ephemeris/core";
import { store, today, useStore } from "../state";
import { TraitChips } from "./traits";

const SOURCE_LABEL: Record<string, string> = {
  task: "task", ritual: "ritual", node: "skill", boss: "boss", dungeon: "dungeon", ward: "ward",
};

export function SheetView() {
  useStore();
  const td = today();
  const sheet = characterSheet(store, td);
  const map = store.settings.tagTraits ?? {};
  const tags = [...new Set([...tagCounts(store.tasks).keys(), ...Object.keys(map)])]
    .filter((t) => !!t)
    .sort((a, b) => a.localeCompare(b));

  return (
    <div class="view sheetview">
      <header class="vh">
        <h1>Character</h1>
        <div class="vh-sub">
          {longDate(td)}, total level {sheet.totalLevel}, {sheet.totalXp} experience
        </div>
      </header>

      <section aria-label="Traits">
        {sheet.traits.map((t) => (
          <div class={`trait-line trait-${t.trait}`} key={t.trait}>
            <div class="tl-name">{TRAIT_LABEL[t.trait]}</div>
            <div class="tl-level">Lv {t.level}</div>
            <div class="tbar" role="progressbar" aria-label={`${TRAIT_LABEL[t.trait]} progress`} aria-valuemin={0} aria-valuemax={t.span} aria-valuenow={t.into}>
              <i style={{ width: `${Math.round(t.frac * 100)}%` }} />
            </div>
            <div class="tl-xp dim small">{t.into}/{t.span}{t.recent ? `  +${t.recent} this week` : ""}</div>
          </div>
        ))}
      </section>

      <h2 class="sh-h">Recent</h2>
      {sheet.recent.length === 0 ? (
        <p class="empty sh-empty">Nothing yet. Finish a task or check in a ritual.</p>
      ) : (
        <ul class="recent">
          {sheet.recent.map((r, i) => (
            <li key={i}>
              <span class="dim small r-day">{relDate(r.day, td)}</span>
              <span class="r-label ellipsis">{r.label}</span>
              <span class="dim small r-src">{SOURCE_LABEL[r.source] ?? r.source}</span>
              <span class="r-xp">+{r.xp}</span>
              <span class="r-traits">{r.traits.map((t) => <i class={`dot-trait trait-${t}`} title={TRAIT_LABEL[t]} />)}</span>
            </li>
          ))}
        </ul>
      )}

      <h2 class="sh-h">Tags and traits</h2>
      <p class="dim small">A tag can add traits to every task that carries it. Tasks and rituals with no traits train Presentation.</p>
      {tags.length === 0 ? (
        <p class="empty sh-empty">No tags yet. Add a tag such as #phys311 to a task.</p>
      ) : (
        <div class="tag-traits">
          {tags.map((tag) => (
            <div class="tt-row" key={tag}>
              <span class="tt-tag">#{tag}</span>
              <TraitChips small value={(map[tag] ?? []) as Trait[]} onChange={(v) => setTagTraits(store, tag, v)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// keep the list of traits referenced so the sheet and the picker never drift apart
void TRAITS;
