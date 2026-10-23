// Run before every build (npm run build does it):
//  1. copy the shared core (TypeScript) into src/core so Metro bundles it as local code;
//  2. create PluginConfig.json once, with a stable random pluginID and the INTERNET permission.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "..", "packages", "core", "src");
const to = join(root, "src", "core");
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
writeFileSync(join(to, "README.md"), "Generated copy of packages/core/src. Do not edit here; run `npm run prepare-plugin`.\n");
console.log("core copied to src/core");

const cfgPath = join(root, "PluginConfig.json");
if (!existsSync(cfgPath)) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const id = [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join("");
  const cfg = {
    name: "Ephemeris",
    desc: pkg.description,
    iconPath: "assets/icon.png",
    versionName: pkg.version,
    versionCode: "1",
    pluginID: id,
    pluginKey: pkg.name,
    jsMainPath: "index",
    author: "TheScholium",
    "uses-permissions": ["plugin.permission.INTERNET"],
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`created PluginConfig.json (pluginID ${id}); commit this file: the Supernote knows the plugin by that id`);
}
