// Line icons drawn on a 16px grid, stroke = currentColor.
import type { JSX } from "preact";

const P: Record<string, string> = {
  // planned: an open circle with a hand, the "intention" mark
  plan: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3l2 1.4",
  // due: a stake in the ground
  due: "M4 14V2.5M4 3h7.5l-1.8 2.6L11.5 8H4",
  repeat: "M3 7a4.5 4.5 0 0 1 8-2.6M11 2.5v2.2H8.8M13 9a4.5 4.5 0 0 1-8 2.6M5 13.5v-2.2h2.2",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3h2.5",
  tag: "M2.5 2.5h5l6 6-5 5-6-6zM5.3 5.3h.01",
  folder: "M2 4.5h4l1.5 1.5H14v7H2z",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.6 2.6 0 0 1 3.6 3.6l-1 1M9 11.5l-1 1a2.6 2.6 0 0 1-3.6-3.6l1-1",
  pin: "M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14zM8 5.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6",
  clip: "M10.5 5.5l-4.3 4.3a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.3 7.9a3.9 3.9 0 0 0 5.5 5.5l3.2-3.2",
  star: "M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z",
  left: "M10 3L5 8l5 5",
  right: "M6 3l5 5-5 5",
  down: "M3.5 6l4.5 4.5L12.5 6",
  plus: "M8 3v10M3 8h10",
  x: "M4 4l8 8M12 4l-8 8",
  check: "M3.5 8.5l3 3 6-7",
  inbox: "M2.5 9.5l1.8-6h7.4l1.8 6v4h-11zM2.5 9.5h3.2l.8 1.6h3l.8-1.6h3.2",
  today: "M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1M8 5.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6",
  upcoming: "M2.5 4h11M2.5 8h11M2.5 12h7",
  calendar: "M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3",
  log: "M3.5 2.5h7l2 2v9h-9zM6 7h4.5M6 9.5h4.5",
  gear: "M12.69 6.58L14.19 6.81L14.19 9.19L12.69 9.42L12.32 10.31L13.22 11.53L11.53 13.22L10.31 12.32L9.42 12.69L9.19 14.19L6.81 14.19L6.58 12.69L5.69 12.32L4.47 13.22L2.78 11.53L3.68 10.31L3.31 9.42L1.81 9.19L1.81 6.81L3.31 6.58L3.68 5.69L2.78 4.47L4.47 2.78L5.69 3.68L6.58 3.31L6.81 1.81L9.19 1.81L9.42 3.31L10.31 3.68L11.53 2.78L13.22 4.47L12.32 5.69Z M8 5.9a2.1 2.1 0 1 0 0 4.2a2.1 2.1 0 1 0 0-4.2",
  search: "M7 2.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4M10 10l3.5 3.5",
  bell: "M4 11V7.2a4 4 0 0 1 8 0V11l1 1.2H3zM6.6 13.6a1.5 1.5 0 0 0 2.8 0",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  skip: "M3.5 3.5l6 4.5-6 4.5zM11.5 3.5v9",
  sub: "M4 2.5v6.5a2 2 0 0 0 2 2h7M10.5 8.5l2.5 2.5-2.5 2.5",
  sync: "M3 8a5 5 0 0 1 8.6-3.5M12 2.5v2.4H9.6M13 8a5 5 0 0 1-8.6 3.5M4 13.5v-2.4h2.4",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  habit: "M13.5 8A5.5 5.5 0 1 1 8 2.5M8 6.3a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0-3.4",
  select: "M3 3h4v4H3zM9 4h4.5M9 6h3M3 9h4v4H3zM9 10h4.5M9 12h3",
  space: "M8 2l5.5 3L8 8 2.5 5zM2.5 8L8 11l5.5-3M2.5 11L8 14l5.5-3",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  up: "M3.5 10L8 5.5l4.5 4.5",
};

export function Icon({ name, size = 16, class: cls, title }: { name: keyof typeof P | string; size?: number; class?: string; title?: string }): JSX.Element {
  return (
    <svg class={`ic ${cls ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : "true"} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] ?? ""} />
    </svg>
  );
}
