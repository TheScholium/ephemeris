# Ephemeris

A task manager that keeps two dates for each task:

- **Planned**: the day (and, if you want, the time) you intend to work on the task.
- **Due**: the day the task must be done by.

Most task managers keep only one of these. Ephemeris keeps both and uses the difference: the Today view shows what you planned, what is due, what is late, which plans slipped, and which deadlines have no plan yet.

It runs on the Mac and iPhone (one web app that installs to the Dock and the Home Screen) and on the Supernote (a plugin in the NOTE and DOC toolbar). All three sync through a small server that runs on a free Cloudflare account.

## Features

| Feature | Mac / iPhone | Supernote |
| --- | --- | --- |
| Planned date and time, due date and time | yes | shows and changes plans |
| Recurring tasks (schedule or after completion) | yes | completes and skips |
| Time estimates, daily load scale | yes | totals |
| Tags (nested: `#school/phys311`), projects, spaces | yes | shows tags |
| Edit tags on many tasks at once, filter by tags (any / all) | yes | no |
| Subtasks (each can have its own dates) | yes | completes with parent |
| Links, a location (Apple Maps / Google Maps), file attachments | yes | no |
| Natural-language quick add | yes | yes (same parser) |
| Calendar view with drag to plan, your own calendars beside tasks | yes | no |
| Your plan inside Apple Calendar or Google Calendar | subscription feed | no |
| Notifications | iPhone (Home Screen app) and Mac | no |
| Works offline, syncs later | yes | yes |

## How it is built

```
packages/core   TypeScript shared by every client and the server:
                data model, recurrence engine, natural-language parser,
                field-level sync merge, views (Today, Upcoming), alarms, iCalendar
worker          Cloudflare Worker: /api/sync, Web Push, attachments,
                calendar feed, pairing codes; serves the web app
web             Preact app (PWA) for Mac and iPhone
supernote       React Native plugin for Supernote (sn-plugin-lib)
```

Sync is offline-first. Each device keeps a full copy. Every field of every record has its own hybrid logical clock, and a merge takes the newer value field by field. Thus an edit to the title on the iPhone and an edit to the due date on the Mac, both made offline, both survive. When two devices complete the same recurring task offline, they create the next instance with the same deterministic id, so you get one next instance, not two.

Notifications are computed on the server when a task changes and stored as alarms. A cron job runs every minute and sends the alarms that are due as Web Push messages. The server encrypts the messages itself (RFC 8291) and signs them with VAPID (RFC 8292); there is no third-party push service account.

Cost: the free tiers of Cloudflare Workers, D1 and KV are sufficient for one person.

## Deploy (about 10 minutes, nothing to install)

GitHub Actions builds and deploys everything. Your Mac needs only a browser.

### 1. Make a Cloudflare API token

1. Make a free account at dash.cloudflare.com (skip any offer to add a domain).
2. Go to **My Profile > API Tokens > Create Token > Create Custom Token**.
3. Give it a name (for example `ephemeris-deploy`) and add these four permissions, all with the type **Account**:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers KV Storage: Edit
   - Account Settings: Read
4. Select **Continue to summary**, then **Create Token**. Copy the token. Cloudflare shows it only once.

### 2. Give the token to GitHub

In this repository: **Settings > Secrets and variables > Actions > New repository secret**.
Name: `CLOUDFLARE_API_TOKEN`. Value: the token.

If your Cloudflare login can see more than one account, also add `CLOUDFLARE_ACCOUNT_ID`.

### 3. Deploy

**Actions > Deploy > Run workflow.** After 2 to 3 minutes, open the finished run. Its summary shows:

- your address, `https://ephemeris.<subdomain>.workers.dev` (the workflow registers the subdomain `thescholium` if the account has none; set the repository variable `WORKERS_SUBDOMAIN` to choose another);
- a 10-digit pairing code, valid for 24 hours and for one device.

From then on, every push to `main` deploys again. Your secrets, database and tasks stay.

### 4. Mac

Open the address in Safari. Type the pairing code in the box at the top of Today. In Safari, use **File > Add to Dock** to get an app window. In Settings, select **Turn on for this device** to get notifications on the Mac.

### 5. iPhone (iOS 16.4 or later)

1. On the Mac, go to **Settings > Add another device > Copy pairing link**, and AirDrop the link to the iPhone. (Or select **Show a pairing code** and type that code on the iPhone.)
2. Open the link in Safari. Tap **Share > Add to Home Screen**.
3. Open Ephemeris from the Home Screen. Notifications work only in the Home Screen app, not in a Safari tab.
4. Go to **Settings > Turn on for this device**, then **Send a test**.

### 6. Supernote

The **Supernote plugin** workflow builds the plugin on every change to `supernote/` or `packages/core/`.

1. Download the newest plugin from the repository's **Releases > Supernote plugin** (`Ephemeris.snplg`). Every change to the plugin replaces this file.
2. Copy `Ephemeris.snplg` to the `MyStyle` folder on the Supernote (USB, or the Supernote Partner app).
3. On the Supernote: **Settings > Apps > Plugins > Add Plugin**, and select the file.
4. Open a note and tap the Ephemeris button in the toolbar.
5. On the Mac, select **Settings > Show a pairing code**. On the Supernote, type the server address and the code. Allow network access with **Always allow**.

`supernote/PluginConfig.json` holds the plugin ID. Do not change it, or the Supernote installs updates as a different plugin.

### Pairing codes and the access token

Devices get the access token through a one-time code, so you never type the token. To connect a device later, use **Settings > Show a pairing code** on a connected device (10 minutes), or run the Deploy workflow with **Make a new pairing code** (24 hours). If a device is lost, run Deploy with **Replace the access token**. Every device must then connect again.

### Alternative: deploy from your Mac

`npm install && npm run setup` does the same from Terminal (Node.js 22.12 or later).

### Show your plan in a calendar

In Settings > Calendars, copy the calendar address. In Apple Calendar: File > New Calendar Subscription, and set the refresh to every 5 minutes. Google Calendar also accepts the address (Other calendars > From URL), but Google refreshes subscriptions only a few times a day.

### Show your calendars beside your tasks

In Google Calendar, open Settings, select a calendar, and copy "Secret address in iCal format". Add it in Ephemeris Settings > Calendars. The server fetches it, so the address does not go to any other service. The events then show in the Calendar view (hatched blocks) while you plan.

## Quick add syntax

| You type | Result |
| --- | --- |
| `tomorrow 9am`, `fri`, `next mon`, `oct 28`, `in 3 days` | planned date and time |
| `due fri 5pm`, `by oct 30`, `before next week` | deadline |
| `3-5pm`, `at 2:30` | planned time; a range also sets the estimate |
| `for 45m`, `~1h30`, `(2h)` | estimate |
| `every weekday`, `every mon, wed`, `every 2 weeks` | repeat on a schedule |
| `every month on the last fri`, `every year on nov 12` | monthly and yearly patterns |
| `every 3 days after done` | repeat counted from completion |
| `#tag`, `#school/phys311` | tags |
| `+Project`, `+Long_name` | project (made if new) |
| `remind 15m before`, `!` | reminder, star |
| `"Read Sunday Times"` | quoted text is not parsed |

Rules that prevent mistakes:

- A weekday name means the next one. On a Wednesday, `wed` is next week. `next fri` is Friday of next week.
- Words that are also normal English (`sun`, `sat`, `weekend`, `the 2nd`, `3/4`) are dates only after a keyword such as `on`, `due` or `by`, or when a time follows (`sat 2pm`).
- A time that has already passed today moves to tomorrow.
- In Today, a new task without a date is planned for today. A task with only a deadline is not.
- A recurring task with a deadline repeats the deadline. The planned date keeps its distance to the deadline (planned Wednesday, due Friday, every week).

## Keyboard (Mac)

`n` new task, `/` find, `j` / `k` move, `Enter` open, `x` select, `d` done, `t` plan for today, `Esc` close, `1` to `5` change view. Cmd-click and Shift-click select several tasks; the bar at the bottom then edits all of them.

## Limits you should know

- Web Push on the iPhone needs iOS 16.4 or later and the Home Screen app. Apple can delay a notification by a few minutes when the phone is in Low Power Mode.
- A web app cannot remind you when you arrive at a location. A task location gives a map link only.
- There are no Home Screen widgets and no Siri integration. A native SwiftUI app would be necessary for these.
- The Supernote plugin runs only while it is open (from the NOTE or DOC toolbar). It cannot show notifications and it cannot read or change the built-in Supernote To-Do list.
- Attachments: 25 MB per file. The free KV tier allows 1 GB in total and 1,000 uploads a day.
- One server is for one person. Anyone with your token can read and change your tasks.

## Development

```sh
npm test                       # core (44 tests) and push crypto tests
cd worker && npx wrangler d1 migrations apply ephemeris --local
npm run dev                    # builds the web app and runs the Worker at http://localhost:8787
npm run dev:web                # Vite dev server at :5173 (proxies /api to :8787)
# live API tests against the local Worker:
cd worker && EPH_URL=http://localhost:8787 EPH_TOKEN=<token from .dev.vars> npx vitest run test/integration.test.ts
```

MIT License.
