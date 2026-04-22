import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "labels.json"), "utf8"));

const flat = new Map();
for (const [category, entries] of Object.entries(raw)) {
  if (category.startsWith("_")) continue;
  if (typeof entries !== "object" || entries === null) continue;
  for (const [addr, name] of Object.entries(entries)) {
    if (addr.startsWith("_")) continue;
    flat.set(addr.toLowerCase(), { category, name });
  }
}

export function labelOf(address) {
  if (!address) return null;
  return flat.get(address.toLowerCase()) ?? null;
}

// "Origin" = somewhere the forensic trail effectively ends. We stop expanding these.
export function isOrigin(address) {
  const l = labelOf(address);
  if (!l) return false;
  return l.category === "cex" || l.category === "bridge" || l.category === "mixer";
}
