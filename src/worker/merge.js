// The rules for bringing a site up to date with its template, shared by the weekly update in the
// site's own Worker (src/worker/update.js) and scripts/update-from-template.mjs: which files are
// never touched, and how the three files a deploy writes into are merged. Pure functions, no I/O.

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

