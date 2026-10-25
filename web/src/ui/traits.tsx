// Trait chips: pick which traits a task or ritual trains.
// "locked" traits come from tags and cannot be turned off here.

import { TRAITS, TRAIT_LABEL, type Trait } from "@ephemeris/core";

export function TraitChips({ value, locked = [], onChange, small }: {
  value: Trait[]; locked?: Trait[]; onChange: (v: Trait[]) => void; small?: boolean;
}) {
  const toggle = (t: Trait) => {
    const next = value.includes(t) ? value.filter((x) => x !== t) : [...value, t];
    onChange(TRAITS.filter((x) => next.includes(x)));
  };
  return (
    <div class={`chips trait-chips ${small ? "small" : ""}`} role="group" aria-label="Traits">
      {TRAITS.map((t) => {
        const fixed = locked.includes(t);
        const on = fixed || value.includes(t);
        return (
          <button
            key={t}
            type="button"
            class={`chip trait-${t} ${on ? "on" : ""} ${fixed ? "fixed" : ""}`}
            aria-pressed={on}
            disabled={fixed}
            title={fixed ? "Added by a tag" : undefined}
            onClick={() => toggle(t)}
          >
            {TRAIT_LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}
