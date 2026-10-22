// Example data for the preview build (no server). Dates are relative to today.
import { addSubtask, createSpace, quickAdd, updateTask, type Project, type Settings } from "@ephemeris/core";
import { parseCtx, store } from "./state";

export const DEMO_LINES = [
  "Read Lee ch. 3, Riemannian metrics tomorrow 9am for 90m due fri #drp +DRP_Riemannian",
  "PHYS 311 problem set 7 due mon 11:59pm for 3h #phys311",
  "Draft problem set 7 solutions on sat 2pm for 2h #phys311",
  "Skim arXiv hep-th every weekday at 8am for 20m #arxiv",
  "PHYS 119 office hours every thu 3-5pm #ta +PHYS_119",
  "Grade PHYS 119 quizzes today 7pm for 1h due tomorrow #ta +PHYS_119",
  "Towed cylinder run: check camera sync today 10am for 45m #lab +Vortex_shedding",
  "Email Josh about the Reynolds number sweep by fri #lab +Vortex_shedding",
  "Capstone application: final review due oct 30 for 1h #internships",
  "Anthropic Fellows essay draft for 2h due nov 3 #internships",
  "Walk Emmy every day at 7am for 30m",
  "Pay rent every month on the 1st",
  "Return library books due yesterday",
  "Prepare DRP talk slides for 3h #drp +DRP_Riemannian",
  "Buy coptic binding thread",
];

export function seedDemo() {
  if (store.tasks.length) return;
  store.batch(() => {
    store.update<Settings>("settings", { digestEnabled: false });
    const ctx = { ...parseCtx(), nowMinutes: 6 * 60 };
    const made = DEMO_LINES.map((l) => quickAdd(store, l, ctx));
    const school = createSpace(store, "School");
    const lab = createSpace(store, "Lab");
    for (const p of store.projects) {
      const sp = /Vortex/.test(p.name) ? lab.id : school.id;
      store.update<Project>(p.id, { spaceId: sp });
    }
    const slides = made.find((t) => t.title.startsWith("Prepare DRP"))!;
    ["Outline the Levi-Civita connection", "Worked example on S2", "Practice run with Josh Mott"].forEach((s) => addSubtask(store, slides.id, s));
    const lee = made.find((t) => t.title.startsWith("Read Lee"))!;
    updateTask(store, lee.id, { links: [{ url: "https://link.springer.com/book/10.1007/978-3-319-91755-9", title: "Lee, Introduction to Riemannian Manifolds" }], notes: "Do exercises 3-1 to 3-4 before the meeting." });
    const oh = made.find((t) => t.title.startsWith("PHYS 119 office"))!;
    updateTask(store, oh.id, { location: { name: "Phillips Hall" } });
  });
}
