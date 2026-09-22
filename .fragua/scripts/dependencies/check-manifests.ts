// check-manifests.ts — the three mechanical rules of a dependency bump, in code.
//
// Called by .fragua/workflows/dependencies.yaml's `manifest_rules` tool step
// after `lockfile_check` wrote .fragua/scratch/deps/{stat.txt,manifests.diff}.
// These are not judgments: an exact pin is a regex, "within scope" is a semver
// component comparison, "manifests only" is a path filter. Jev is kept for the
// one question that needs reading — how likely a bump is to break a consumer.
//
// Exit 0 when every rule holds; exit 1 with one line per violation on stderr.
//
//   bun .fragua/scripts/dependencies/check-manifests.ts <patch|minor|major> [scratch-dir]

import { readFileSync } from "node:fs";

const scope = process.argv[2];
if (scope !== "patch" && scope !== "minor" && scope !== "major") {
  console.error(`scope must be patch | minor | major (got ${JSON.stringify(scope)})`);
  process.exit(2);
}
const dir = process.argv[3] ?? ".fragua/scratch/deps";
const stat = readFileSync(`${dir}/stat.txt`, "utf8");
const diff = readFileSync(`${dir}/manifests.diff`, "utf8");
const violations: string[] = [];

// (c) manifests only: every changed path is a package.json or the lockfile.
for (const line of stat.split("\n")) {
  const m = /^\s*(\S+)\s+\|/.exec(line);
  if (m === null) continue;
  const path = m[1] ?? "";
  if (!(path === "package.json" || path.endsWith("/package.json") || path === "bun.lock")) {
    violations.push(`manifests_only: ${path} changed`);
  }
}

// Changed dependency lines: `"name": "version"` on a removed / added line,
// keyed by (file, name). Keying by name alone collapsed the whole workspace
// into one entry: the same dep pinned at different versions in two packages
// left only the last one parsed, so an out-of-scope bump in an earlier file
// was compared against a later file's version and silently passed.
const before = new Map<string, string>();
const after = new Map<string, string>();
const SEP = "\u0000";
let file = "";
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) {
    file = line.slice(4).trim().replace(/^b\//, "");
    continue;
  }
  if (line.startsWith("--- ")) continue;
  const sign = line[0];
  if (sign !== "+" && sign !== "-") continue;
  const m = /^\s*"([^"]+)":\s*"([^"]+)"/.exec(line.slice(1));
  if (m === null) continue;
  (sign === "-" ? before : after).set(`${file}${SEP}${m[1] ?? ""}`, m[2] ?? "");
}

const EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const parts = (v: string): [number, number] => {
  const [M, m] = v.replace(/[-+].*$/, "").split(".");
  return [Number(M), Number(m)];
};

for (const [key, ver] of after) {
  const old = before.get(key);
  const sep = key.indexOf(SEP);
  const where = key.slice(0, sep);
  const name = `${key.slice(sep + 1)}${where === "" ? "" : ` (${where})`}`;
  if (ver.startsWith("workspace:")) {
    // (c) an internal dependency is never bumped by this workflow.
    if (old !== undefined && old !== ver) violations.push(`manifests_only: internal dependency ${name} changed (${old} → ${ver})`);
    continue;
  }
  // (a) exact pins.
  if (!EXACT.test(ver)) {
    violations.push(`exact_pins: ${name} is "${ver}"`);
    continue;
  }
  // (b) within scope, against the removed version of the same package.
  if (old === undefined || !EXACT.test(old)) continue;
  const [oM, om] = parts(old);
  const [nM, nm] = parts(ver);
  if (scope === "patch" && (oM !== nM || om !== nm)) violations.push(`scope_respected: ${name} ${old} → ${ver} is beyond patch`);
  if (scope === "minor" && oM !== nM) violations.push(`scope_respected: ${name} ${old} → ${ver} is beyond minor`);
}

for (const v of violations) console.error(v);
process.exit(violations.length === 0 ? 0 : 1);
