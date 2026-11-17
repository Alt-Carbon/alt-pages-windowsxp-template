// Brings this site up to date with the template it was made from, without anything run by the
// company: .github/workflows/update.yml runs it once a week on GitHub, then builds and tests the
// result, and only pushes it to main (which redeploys the site) if both pass.
//
//  1. Reads which template from package.json (`portfolio.templateRepo`). Stops if Site settings →
//     Advanced → "Get improvements automatically" is off (`advanced.autoUpdate: false`).
//  2. Fetches the template's main branch into a throwaway repository in the temp folder.
//  3. Copies the template's files over this site's, except the protected ones: content/ (the
//     words and settings), public/media/ (uploaded photos and files) and .github/ (GitHub does not
//     let the workflow's token change workflow files). The same rules as the dashboard's update
//     pull requests (alt-pages-platform/dashboard/src/update.js), except that wrangler.jsonc is
//     merged instead of skipped: the template's version, with this site's Worker name, KV
//     namespace ids and any routes. package.json and package-lock.json keep this site's name.
//     Files the site has that the template no longer has are removed, again except protected ones.
//  4. Stages exactly those changes in git and writes `changed` and `sha` to $GITHUB_OUTPUT.
//     Nothing changed: nothing staged, `changed=false`.
//
// node scripts/update-from-template.mjs              update the working tree and stage it
// node scripts/update-from-template.mjs --dry-run    only say what would change
// node scripts/update-from-template.mjs --from=<git url or path>   another source, for trying it out
//
// The planning and merging are pure functions, exported for test/update.test.mjs.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// --- what is never touched ---------------------------------------------------------------

export const PROTECTED = [/^content\//, /^public\/media\//, /^\.github\//];
export const isProtected = (path) => PROTECTED.some((re) => re.test(path));

// "owner/name" of the template, or "" when package.json does not say.
export function templateRepoOf(pkg) {
  const repo = String(pkg?.portfolio?.templateRepo || "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : "";
}

// Only an explicit "off" stops updates; a site.json from before the setting existed gets them.
export const optedOut = (site) => site?.advanced?.autoUpdate === false;

// --- JSON with comments (wrangler.jsonc) ----------------------------------------------------

// A small reader for JSONC that knows where each top-level value sits in the text, so a merge can
// replace one value and leave the comments and layout around it alone.
function scanner(text) {
  const ws = (i) => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) {
        const n = text.indexOf("\n", i);
        i = n < 0 ? text.length : n;
      } else if (text.startsWith("/*", i)) {
        const n = text.indexOf("*/", i + 2);
        i = n < 0 ? text.length : n + 2;
      } else return i;
    }
  };
  const str = (i) => {
    for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
    if (i >= text.length) throw new Error("unterminated string");
    return i + 1;
  };
  const value = (i) => {
    if (text[i] === '"') return str(i);
    if (text[i] === "{" || text[i] === "[") {
      for (let depth = 0; ; ) {
        i = ws(i);
        const c = text[i];
        if (c === undefined) throw new Error("unclosed bracket");
        if (c === '"') { i = str(i); continue; }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") if (--depth === 0) return i + 1;
        i++;
      }
    }
    const start = i;
    while (i < text.length && !/[\s,}\]/]/.test(text[i])) i++;
    if (i === start) throw new Error(`unexpected ${JSON.stringify(text[i] ?? "end")}`);
    return i;
  };
  return { ws, str, value };
}

// Strips comments and trailing commas, then JSON.parse. Throws on anything unreadable.
export function parseJsonc(text) {
  const { ws, str } = scanner(text);
  let out = "";
  for (let i = 0; i < text.length; ) {
    const next = ws(i);
    if (next > i) {
      out += " ";
      i = next;
    } else if (text[i] === '"') {
      const end = str(i);
      out += text.slice(i, end);
      i = end;
    } else if (text[i] === "," && /[}\]]/.test(text[ws(i + 1)] || "")) {
      i++;
    } else {
      out += text[i++];
    }
  }
  return JSON.parse(out);
}

// Where each top-level key's value starts and ends, and where the root object closes.
function topLevel(text) {
  const { ws, str, value } = scanner(text);
  let i = ws(0);
  if (text[i] !== "{") throw new Error("not an object");
  const keys = new Map();
  let last = i + 1;
  for (i++; ; ) {
    i = ws(i);
    if (text[i] === "}") return { keys, last };
    if (text[i] === ",") { i++; last = i; continue; }
    if (text[i] !== '"') throw new Error(`unexpected ${JSON.stringify(text[i] ?? "end")}`);
    const k = i;
    i = str(i);
    const key = JSON.parse(text.slice(k, i));
    i = ws(i);
    if (text[i] !== ":") throw new Error(`no colon after ${key}`);
    const start = ws(i + 1);
    i = value(start);
    keys.set(key, { start, end: i });
    last = i;
  }
}

// One line, in the file's own style: { "binding": "BOOKS", "id": "…" }.
const inline = (v) =>
  Array.isArray(v) ? `[${v.map(inline).join(", ")}]`
  : v && typeof v === "object" ? (Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }` : "{}")
  : JSON.stringify(v);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Sets one top-level key in JSONC text: replaces its value where it is, or adds it at the end.
function setTopLevel(text, key, v) {
  const { keys, last } = topLevel(text);
  const at = keys.get(key);
  if (at) return text.slice(0, at.start) + inline(v) + text.slice(at.end);
  const comma = keys.size && !text.slice(0, last).endsWith(",") ? "," : "";
  return text.slice(0, last) + `${comma}\n  ${JSON.stringify(key)}: ${inline(v)}` + text.slice(last);
}

// What a deploy wrote into the site's copy and must survive an update: the Worker's name, the KV
// namespace ids (matched by binding) and, if someone added them, routes or the account id.
const KEEP_FROM_SITE = ["name", "account_id", "route", "routes"];

// The template's wrangler.jsonc with this site's own values put back. If either file cannot be
// read, the site's file stays as it is.
export function mergeWrangler(templateText, siteText) {
  let t, s;
  try {
    t = parseJsonc(templateText);
    s = parseJsonc(siteText);
  } catch {
    return siteText;
  }
  const want = {};
  for (const key of KEEP_FROM_SITE) if (s[key] !== undefined) want[key] = s[key];
  if (Array.isArray(t.kv_namespaces)) {
    const mine = Array.isArray(s.kv_namespaces) ? s.kv_namespaces : [];
    want.kv_namespaces = t.kv_namespaces.map((ns) => {
      const id = mine.find((m) => m && m.binding === ns.binding)?.id;
      return id ? { ...ns, id } : ns;
    });
  }
  try {
    let out = templateText;
    for (const [key, v] of Object.entries(want)) if (!same(t[key], v)) out = setTopLevel(out, key, v);
    parseJsonc(out);
    return out;
  } catch {
    return siteText;
  }
}

// The template's package.json with this site's name.
export function mergePackage(templateText, siteText) {
  try {
    const t = JSON.parse(templateText), s = JSON.parse(siteText);
    if (!s.name || t.name === s.name) return templateText;
    return JSON.stringify({ ...t, name: s.name }, null, 2) + "\n";
  } catch {
    return templateText;
  }
}

// The template's package-lock.json with this site's name in its two places, so it still matches.
export function mergeLock(templateText, siteText) {
  try {
    const t = JSON.parse(templateText), s = JSON.parse(siteText);
    const name = s.name, rootName = s.packages?.[""]?.name;
    if ((!name || t.name === name) && (!rootName || t.packages?.[""]?.name === rootName)) return templateText;
    if (name) t.name = name;
    if (rootName && t.packages?.[""]) t.packages[""].name = rootName;
    return JSON.stringify(t, null, 2) + "\n";
  } catch {
    return templateText;
  }
}

export const MERGE = { "wrangler.jsonc": mergeWrangler, "package.json": mergePackage, "package-lock.json": mergeLock };

const bytes = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v)));

// template, site: Map of path → contents (Buffer or string). The site's map is its tracked files.
// Returns the files to write (path → Buffer) and the paths to remove; both empty when up to date.
export function planUpdate(template, site) {
  const write = new Map(), remove = [];
  for (const [path, content] of template) {
    if (isProtected(path)) continue;
    let next = bytes(content);
    if (MERGE[path] && site.has(path)) next = Buffer.from(MERGE[path](next.toString("utf8"), bytes(site.get(path)).toString("utf8")));
    if (!site.has(path) || !bytes(site.get(path)).equals(next)) write.set(path, next);
  }
  for (const path of site.keys()) if (!template.has(path) && !isProtected(path)) remove.push(path);
  return { write, remove: remove.sort() };
}

// --- running it ----------------------------------------------------------------------------

const git = (args, opts = {}) => execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"], ...opts });

// Every file on the template's main branch, and the commit it came from.
function fetchTemplate(source) {
  const dir = mkdtempSync(join(tmpdir(), "template-"));
  try {
    git(["init", "--quiet", "--bare", dir]);
    git(["-C", dir, "fetch", "--quiet", "--depth=1", "--no-tags", source, "main"]);
    const sha = git(["-C", dir, "rev-parse", "FETCH_HEAD"]).toString().trim();
    // mode type sha<TAB>path, NUL-separated. Only regular files: no links, no submodules.
    const entries = git(["-C", dir, "ls-tree", "-r", "-z", "FETCH_HEAD"]).toString("utf8").split("\0").filter(Boolean)
      .map((line) => { const [meta, path] = line.split("\t"); const [mode, type, blob] = meta.split(" "); return { mode, type, blob, path }; })
      .filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755"));
    // One `cat-file --batch` for all of them: "<sha> blob <size>\n<bytes>\n" each.
    const out = git(["-C", dir, "cat-file", "--batch"], { input: entries.map((e) => e.blob).join("\n") + "\n" });
    const files = new Map();
    let at = 0;
    for (const e of entries) {
      const nl = out.indexOf(10, at);
      const size = Number(out.subarray(at, nl).toString().split(" ")[2]);
      files.set(e.path, out.subarray(nl + 1, nl + 1 + size));
      at = nl + 1 + size + 1;
    }
    return { sha, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The site's tracked files as they are in the working tree.
function siteFiles() {
  const files = new Map();
  for (const path of git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean)) {
    if (existsSync(path)) files.set(path, readFileSync(path));
  }
  return files;
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function main(argv) {
  const dry = argv.includes("--dry-run");
  const from = argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);
  const repo = templateRepoOf(JSON.parse(readFileSync("package.json", "utf8")));
  if (!repo && !from) {
    console.log("update: package.json does not name a template (portfolio.templateRepo), so there is nothing to update from.");
    return output({ changed: false });
  }
  let site = {};
  try { site = JSON.parse(readFileSync("content/site.json", "utf8")); } catch {}
  if (optedOut(site)) {
    console.log("update: automatic updates are turned off (Site settings → Advanced → Get improvements automatically).");
    return output({ changed: false });
  }

  const source = from || `https://github.com/${repo}.git`;
  const { sha, files } = fetchTemplate(source);
  const short = sha.slice(0, 7);
  const { write, remove } = planUpdate(files, siteFiles());
  if (!write.size && !remove.length) {
    console.log(`update: already up to date with ${repo || source} at ${short}.`);
    return output({ changed: false, sha: short });
  }
  for (const path of write.keys()) console.log(`update ${path}`);
  for (const path of remove) console.log(`remove ${path}`);
  if (dry) {
    console.log(`update: ${write.size} to update, ${remove.length} to remove, from ${repo || source} at ${short}. Dry run: nothing changed.`);
    return output({ changed: false, sha: short });
  }
  for (const [path, content] of write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (write.size) git(["add", "-f", "--", ...write.keys()]);
  if (remove.length) git(["rm", "--quiet", "--", ...remove]);
  console.log(`update: ${write.size} updated, ${remove.length} removed, from ${repo || source} at ${short}. Staged, not committed.`);
  output({ changed: true, sha: short });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`update: ${e.message}`);
    process.exit(1);
  });
}
