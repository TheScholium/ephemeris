#!/usr/bin/env node
// One-command setup on a free Cloudflare account:
//   database (D1), file store (KV), secrets, Web Push keys, web app build, deploy.
// Safe to run again: it reuses what already exists and never rotates your token.
//
//   npm install && npm run setup

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes, webcrypto } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(root, "worker");
const toml = join(worker, "wrangler.toml");
const secretsFile = join(worker, ".secrets.json"); // gitignored; lets reruns keep the same token

const say = (s = "") => process.stdout.write(s + "\n");
const step = (s) => say(`\n== ${s}`);
const wr = (args) => execSync(`npx wrangler ${args}`, { cwd: worker, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** Run wrangler in this terminal (prompts visible); stop setup if it fails. */
function run(args, failMsg) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: worker, stdio: "inherit" });
  if (r.status !== 0) throw new Error(failMsg);
}

/** Like run(), but also keep a copy of the output (to read the deployed address). */
function runInTerminal(args, failMsg) {
  const log = join(worker, ".deploy-log.txt");
  const cmd = ["npx", "wrangler", ...args];
  // `script` records the output while wrangler still sees a real terminal
  const r = process.platform === "darwin"
    ? spawnSync("script", ["-q", log, ...cmd], { cwd: worker, stdio: "inherit" })
    : spawnSync("script", ["-q", "-e", "-c", cmd.join(" "), log], { cwd: worker, stdio: "inherit" });
  let out = "";
  try {
    out = readFileSync(log, "utf8");
    unlinkSync(log);
  } catch {
    /* no log */
  }
  if (r.status !== 0) throw new Error(failMsg);
  return out;
}

async function vapidKeys() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = b64u(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await webcrypto.subtle.exportKey("jwk", kp.privateKey);
  return { VAPID_PUBLIC: pub, VAPID_PRIVATE: jwk.d };
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  step("Cloudflare login");
  const who = spawnSync("npx", ["wrangler", "whoami"], { cwd: worker, encoding: "utf8" });
  if (/not authenticated|You are not/i.test(who.stdout + who.stderr)) {
    say("A browser window opens: sign in to (or create) a free Cloudflare account.");
    spawnSync("npx", ["wrangler", "login"], { cwd: worker, stdio: "inherit" });
  } else {
    say("Already signed in.");
  }

  let conf = readFileSync(toml, "utf8");

  step("Database (D1)");
  let dbId = conf.match(/database_id = "([0-9a-f-]{36})"/)?.[1];
  if (!dbId || /^0+-/.test(dbId)) {
    let list = [];
    try {
      list = JSON.parse(wr("d1 list --json"));
    } catch {
      /* older wrangler */
    }
    dbId = list.find((d) => d.name === "ephemeris")?.uuid;
    if (!dbId) {
      const out = wr("d1 create ephemeris");
      dbId = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    }
    if (!dbId) throw new Error("Could not create or find the D1 database.");
    conf = conf.replace(/database_id = "[^"]*"/, `database_id = "${dbId}"`);
  }
  say(`database_id ${dbId}`);

  step("File store (KV)");
  let kvId = conf.match(/\[\[kv_namespaces\]\][^[]*?id = "([0-9a-f]{32})"/s)?.[1];
  if (!kvId || /^0+$/.test(kvId)) {
    let list = [];
    try {
      list = JSON.parse(wr("kv namespace list"));
    } catch {
      /* ignore */
    }
    kvId = list.find((n) => /ephemeris.*FILES|FILES/.test(n.title))?.id;
    if (!kvId) {
      const out = wr("kv namespace create FILES");
      kvId = out.match(/[0-9a-f]{32}/)?.[0];
    }
    if (!kvId) throw new Error("Could not create or find the KV namespace.");
    conf = conf.replace(/(\[\[kv_namespaces\]\][^[]*?id = ")[^"]*(")/s, `$1${kvId}$2`);
  }
  say(`kv id ${kvId}`);

  step("Contact address for push services");
  const cur = conf.match(/VAPID_SUBJECT = "mailto:([^"]*)"/)?.[1] ?? "";
  let email = cur && cur !== "you@example.com" ? cur : "";
  if (!email) {
    email = (await rl.question("Email address push services may contact if your server misbehaves (stays in your config): ")).trim();
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That does not look like an email address.");
  conf = conf.replace(/VAPID_SUBJECT = "[^"]*"/, `VAPID_SUBJECT = "mailto:${email}"`);
  writeFileSync(toml, conf);

  step("Tables");
  run(["d1", "migrations", "apply", "ephemeris", "--remote"], "Could not create the tables.");

  step("Build the web app");
  execSync("npm run build:web", { cwd: root, stdio: "inherit" });

  step("Deploy");
  say("If Cloudflare asks to register a workers.dev subdomain, answer yes and pick a short name.");
  say("Your address becomes https://ephemeris.<that-name>.workers.dev");
  const deployOut = runInTerminal(["deploy"], "The deploy failed.");
  const url = deployOut.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];

  step("Secrets");
  let secrets;
  if (existsSync(secretsFile)) {
    secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
    say("Reusing the existing token and keys.");
  } else {
    secrets = { API_TOKEN: b64u(randomBytes(24)), ICS_TOKEN: b64u(randomBytes(18)), ...(await vapidKeys()) };
    writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  const tmp = join(worker, ".secrets-upload.json");
  writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
  try {
    run(["secret", "bulk", tmp], "Could not save the secrets to Cloudflare.");
  } finally {
    unlinkSync(tmp);
  }
  writeFileSync(join(worker, ".dev.vars"), Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  rl.close();

  say("\n----------------------------------------------------------------");
  if (url) {
    say(`Your server:   ${url}`);
    say(`Access token:  ${secrets.API_TOKEN}`);
    say(`Mac (open this once, it pairs the browser):`);
    say(`  ${url}/#/pair?token=${secrets.API_TOKEN}`);
    say(`iPhone: open the same link in Safari, tap Share, Add to Home Screen,`);
    say(`  open Ephemeris from the Home Screen, then Settings > Turn on for this device.`);
    say(`Supernote: Settings > Show a pairing code, then type it in the plugin.`);
  } else {
    say("Deploy finished, but the address was not in the output. It is shown in the Cloudflare dashboard under Workers & Pages > ephemeris.");
    say(`Access token: ${secrets.API_TOKEN}`);
  }
  say("Keep worker/.secrets.json private; it holds your token and push keys.");
}

main().catch((e) => {
  console.error(`\nSetup stopped: ${e.message}`);
  console.error("Fix the problem shown above and run `npm run setup` again. It reuses what already exists.");
  process.exit(1);
});
