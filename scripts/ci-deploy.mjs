#!/usr/bin/env node
// Deploys Ephemeris from GitHub Actions. Safe to run on every push:
// it finds what already exists in your Cloudflare account and creates only what is missing.
//
//   1. workers.dev subdomain (registered if the account has none)
//   2. D1 database "ephemeris" and KV namespace "ephemeris-files"
//   3. database tables (migrations)
//   4. deploy (the web app must already be built into web/dist)
//   5. secrets: generated once, never printed; kept on later deploys
//   6. a one-time pairing code, written to the job summary (first deploy, or when asked)
//
// Environment: CLOUDFLARE_API_TOKEN (required), CLOUDFLARE_ACCOUNT_ID (optional),
//              NEW_PAIRING_CODE=true, ROTATE_TOKEN=true, SUBDOMAIN=<name> (optional)

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt, webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(root, "worker");
const tomlPath = join(worker, "wrangler.toml");
const NAME = "ephemeris";
const API = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4"; // override only for tests
const token = process.env.CLOUDFLARE_API_TOKEN;

const log = (s) => console.log(s);
const summary = (s) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + "\n");
};
const b64u = (buf) => Buffer.from(buf).toString("base64url");

const PERMS =
  "The API token needs: Account > Workers Scripts: Edit, Account > D1: Edit, Account > Workers KV Storage: Edit, Account > Account Settings: Read.";

async function cf(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

function fail(msg) {
  console.error(`::error::${msg}`);
  summary(`### Deploy stopped\n\n${msg}\n`);
  process.exit(1);
}

function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: worker,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    ...opts,
  });
}

let accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";

async function main() {
  if (!token) fail("CLOUDFLARE_API_TOKEN is not set.");

  // ---- account ----
  if (!accountId) {
    const r = await cf("GET", "/accounts?per_page=50");
    if (!r.ok) fail(`Cloudflare refused the API token (HTTP ${r.status}). ${PERMS}`);
    const accounts = r.data.result ?? [];
    if (accounts.length !== 1) {
      fail(`The token can see ${accounts.length} accounts. Add a repository secret CLOUDFLARE_ACCOUNT_ID with the one to use.`);
    }
    accountId = accounts[0].id;
  }
  log(`Account ${accountId.slice(0, 6)}...`);

  // ---- workers.dev subdomain ----
  let sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
  let subdomain = sub.ok ? sub.data.result?.subdomain : null;
  if (!subdomain) {
    const owner = (process.env.GITHUB_REPOSITORY_OWNER || "ephemeris").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const wanted = [process.env.SUBDOMAIN, owner, `${owner}-${randomInt(1000, 9999)}`].filter(Boolean);
    for (const name of wanted) {
      const r = await cf("PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain: name });
      if (r.ok) {
        subdomain = r.data.result?.subdomain ?? name;
        log(`Registered the subdomain ${subdomain}.workers.dev`);
        break;
      }
      log(`Subdomain ${name} is not available (${r.data.errors?.[0]?.message ?? r.status}).`);
    }
    if (!subdomain) fail(`Could not register a workers.dev subdomain. Choose one in the Cloudflare dashboard (Workers & Pages), then run this workflow again. ${PERMS}`);
  }
  const url = `https://${NAME}.${subdomain}.workers.dev`;

  // ---- D1 ----
  let r = await cf("GET", `/accounts/${accountId}/d1/database?name=${NAME}&per_page=100`);
  if (!r.ok) fail(`Could not list D1 databases (HTTP ${r.status}). ${PERMS}`);
  let dbId = (r.data.result ?? []).find((d) => d.name === NAME)?.uuid;
  if (!dbId) {
    r = await cf("POST", `/accounts/${accountId}/d1/database`, { name: NAME });
    if (!r.ok) fail(`Could not create the D1 database: ${r.data.errors?.[0]?.message ?? r.status}. ${PERMS}`);
    dbId = r.data.result.uuid;
    log("Created the D1 database.");
  }

  // ---- KV ----
  const kvTitle = `${NAME}-files`;
  r = await cf("GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  if (!r.ok) fail(`Could not list KV namespaces (HTTP ${r.status}). ${PERMS}`);
  let kvId = (r.data.result ?? []).find((n) => n.title === kvTitle)?.id;
  if (!kvId) {
    r = await cf("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title: kvTitle });
    if (!r.ok) fail(`Could not create the KV namespace: ${r.data.errors?.[0]?.message ?? r.status}. ${PERMS}`);
    kvId = r.data.result.id;
    log("Created the KV namespace.");
  }

  // ---- write ids into the config used for this deploy (not committed) ----
  let toml = readFileSync(tomlPath, "utf8");
  toml = toml.replace(/database_id = "[^"]*"/, `database_id = "${dbId}"`);
  toml = toml.replace(/(\[\[kv_namespaces\]\][^[]*?id = ")[^"]*(")/s, `$1${kvId}$2`);
  writeFileSync(tomlPath, toml);

  // ---- tables ----
  log("Applying database migrations.");
  wrangler(["d1", "migrations", "apply", NAME, "--remote"], { stdio: ["ignore", "inherit", "inherit"] });

  // ---- deploy ----
  log("Deploying.");
  wrangler(["deploy"], { stdio: ["ignore", "inherit", "inherit"] });

  // ---- secrets ----
  r = await cf("GET", `/accounts/${accountId}/workers/scripts/${NAME}/secrets`);
  const have = new Set(r.ok ? (r.data.result ?? []).map((s) => s.name) : []);
  const rotate = process.env.ROTATE_TOKEN === "true";
  const add = {};
  if (!have.has("API_TOKEN") || rotate) add.API_TOKEN = b64u(randomBytes(24));
  if (!have.has("ICS_TOKEN") || rotate) add.ICS_TOKEN = b64u(randomBytes(18));
  if (!have.has("VAPID_PUBLIC") || !have.has("VAPID_PRIVATE")) {
    const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    add.VAPID_PUBLIC = b64u(await webcrypto.subtle.exportKey("raw", kp.publicKey));
    add.VAPID_PRIVATE = (await webcrypto.subtle.exportKey("jwk", kp.privateKey)).d;
  }
  const firstDeploy = !have.has("API_TOKEN");
  if (Object.keys(add).length) {
    log(`Saving ${Object.keys(add).length} secret(s): ${Object.keys(add).join(", ")}`);
    const tmp = join(worker, ".secrets-upload.json");
    writeFileSync(tmp, JSON.stringify(add), { mode: 0o600 });
    try {
      wrangler(["secret", "bulk", tmp], { stdio: ["ignore", "ignore", "inherit"] });
    } finally {
      unlinkSync(tmp);
    }
  }

  // ---- health check ----
  let healthy = false;
  for (let i = 0; i < 10 && !healthy; i++) {
    try {
      const h = await fetch(`${url}/api/health`);
      healthy = h.ok && (await h.json()).ok === true;
    } catch {
      /* not yet reachable */
    }
    if (!healthy) await new Promise((res) => setTimeout(res, 3000));
  }

  // ---- pairing code ----
  // Stored like a code made in Settings, but valid for 24 hours. Ten digits, single use.
  let code = null;
  if (firstDeploy || rotate || process.env.NEW_PAIRING_CODE === "true") {
    code = String(randomInt(0, 1e10)).padStart(10, "0");
    const exp = Date.now() + 24 * 3600_000;
    wrangler(["d1", "execute", NAME, "--remote", "--command",
      `INSERT OR REPLACE INTO meta (k, v) VALUES ('pair:${code}', '${exp}')`], { stdio: ["ignore", "ignore", "inherit"] });
  }

  summary(`## Ephemeris is deployed\n`);
  summary(`Address: **${url}**${healthy ? "" : " (the server did not answer the health check yet; wait one minute)"}\n`);
  if (code) {
    summary(`### Connect your first device\n`);
    summary(`1. Open ${url} on your Mac.`);
    summary(`2. Type this code in the box at the top of Today: **${code.slice(0, 5)} ${code.slice(5)}**`);
    summary(`3. The code works once and expires in 24 hours. Connect the other devices from Settings > Add another device.\n`);
    summary(`Lost the code? Run this workflow again with "Make a new pairing code" selected.`);
  } else {
    summary(`Your devices update the next time you open the app.`);
  }
  log(`Done: ${url}`);
}

main().catch((e) => fail(e?.message ?? String(e)));
