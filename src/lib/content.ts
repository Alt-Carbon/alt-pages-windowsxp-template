// Loads and validates every content file once per build, and gives the pages
// the few helpers they share.
import { getCollection } from "astro:content";
import siteJson from "../../content/site.json";
import nowJson from "../../content/now.json";
import aboutJson from "../../content/about.json";
import readingJson from "../../content/reading.json";
import researchJson from "../../content/research.json";
import writingJson from "../../content/writing.json";
import pkg from "../../package.json";
import accents from "./accents.json";
import { About, LINK_KINDS, Now, Reading, Research, Site, WritingPage } from "./schemas";

// Typographic quotes: ' and " become curly in everything people type, links and markup aside.
// Applied to every string in the content files except addresses and ids.
const RAW = new Set(["url", "photo", "goodreads", "medium", "substack", "hide", "link", "owner", "repo", "authWorker", "accent", "updated", "date", "kind"]);
export function smart(s: string): string {
  return s.split(/(\]\([^)]*\)|<[^>]*>)/).map((part, i) => (i % 2 ? part : part
    .replace(/(^|[\s([{\u2014\u2013-])"/g, "$1\u201c").replace(/"/g, "\u201d")
    .replace(/'(?=\d)/g, "\u2019").replace(/(^|[\s([{\u2014\u2013-])'/g, "$1\u2018").replace(/'/g, "\u2019"))).join("");
}
function smarten(v: unknown, key = ""): unknown {
  if (typeof v === "string") return RAW.has(key) ? v : smart(v);
  if (Array.isArray(v)) return v.map((x) => smarten(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, smarten(x, k)]));
  return v;
}

function load<T>(name: string, schema: { safeParse: (v: unknown) => any }, value: unknown): T {
  const r = schema.safeParse(smarten(value));
  if (!r.success) {
    const lines = r.error.issues.map((i: any) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`content/${name}.json is not valid:\n${lines}`);
  }
  return r.data as T;
}

export const site = load<ReturnType<typeof Site.parse>>("site", Site, siteJson);
export const now = load<ReturnType<typeof Now.parse>>("now", Now, nowJson);
export const about = load<ReturnType<typeof About.parse>>("about", About, aboutJson);
export const reading = load<ReturnType<typeof Reading.parse>>("reading", Reading, readingJson);
// Older sites keep Articles and Misc as two lists: fold them into Links. Dated links come first, newest first.
if (!reading.links.length) {
  const kindOf = (k: string) => LINK_KINDS.find((x) => x.toLowerCase() === k.trim().toLowerCase()) ?? "Article";
  reading.links = [
    ...reading.articles.map((a) => ({ ...a, kind: "Article" })),
    ...reading.misc.map((m) => ({ ...m, kind: kindOf(m.kind), date: "" })),
  ];
}
reading.links.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
export const research = load<ReturnType<typeof Research.parse>>("research", Research, researchJson);
export const writingPage = load<ReturnType<typeof WritingPage.parse>>("writing", WritingPage, writingJson);

// The site's address. It isn't known at build time (everyone deploys to their own account and may add
// a domain later), so built pages carry ORIGIN_TOKEN and the Worker swaps in the address the visitor
// used (src/worker/index.js). Advanced > Site address in the editor bakes one in instead.
export const ORIGIN_TOKEN = "https://__origin__";
export function origin(url: URL): string {
  const fixed = site.advanced.url.trim().replace(/\/+$/, "");
  if (fixed) return fixed;
  return import.meta.env.DEV ? url.origin : ORIGIN_TOKEN;
}

// Whether the owner has connected Medium or Substack: their posts join the Writing page in the browser.
export const elsewhere = Boolean(site.medium.trim() || site.substack.trim());

// Where a piece published on another site lives, for the small chip beside its title: the platform's
// name when it is one the sync knows, else the host.
export function whereIs(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "medium.com" || host.endsWith(".medium.com")) return "Medium";
    if (host === "substack.com" || host.endsWith(".substack.com")) return "Substack";
    return host;
  } catch {
    return "";
  }
}

// The accent picked in the editor, as a light-mode and a dark-mode colour.
export const accent = accents.find((a) => a.id === site.accent) ?? accents[0];

export const template = { name: "xp", version: pkg.version as string };

// Written by scripts/prepare.mjs before each build: who owns the repository.
let build: { owner: string; repo: string; builtAt: string } = { owner: "", repo: "", builtAt: new Date().toISOString() };
try {
  build = (await import("../generated/build.json")).default as typeof build;
} catch {
  /* dev without prepare: fall back to the settings file */
}
export const owner = build.owner || site.advanced.owner || site.owner;
export const repo = build.repo || site.advanced.repo || site.repo;

// Pages in menu order. The editor cannot reorder these yet.
export const pages = [
  { id: "writing", label: "Writing", href: "/writing" },
  { id: "research", label: "Research", href: "/research" },
  { id: "reading", label: "Reading", href: "/reading" },
  { id: "now", label: "Now", href: "/now" },
  { id: "about", label: "About", href: "/about" },
];

// Which pages are on the site: a page with nothing in it stays out of the menu, the home page and the
// sitemap, so a new site starts as Home and About and grows as its owner adds things. Now is the
// exception: it is never empty, only stale, so it has its own switch in the editor.
export async function shown(): Promise<Set<string>> {
  const on = new Set(["about"]);
  if ((await writing()).length || elsewhere) on.add("writing"); // posts from Medium or Substack fill it too
  if (research.items.length) on.add("research");
  if (reading.show) on.add("reading"); // a sample shelf shows until a Goodreads profile is connected
  if (now.show) on.add("now");
  return on;
}
// Work history: the current role (no end date) and readable ranges like "2020 – 2023" or "2023 – now".
export const currentRole = about.experience.find((e) => !e.end);
export const years = (e: { start: string; end: string }) => {
  const a = e.start.slice(0, 4), b = e.end ? e.end.slice(0, 4) : "now";
  return a === b ? a : `${a} – ${b}`;
};

export async function menu() {
  const on = await shown();
  return pages.filter((p) => on.has(p.id));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function day(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d + "T00:00:00Z") : d;
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
export function monthYear(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Inline Markdown for short strings: *italic*, **bold**, [text](url). Everything else is escaped.
export function inline(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*]+)\*(?!\w)/g, "$1<i>$2</i>");
}

// An author list with the owner's own name in bold, matched in the usual citation forms:
// "Asha Rao", "A. Rao", "A Rao", "Rao, A.", "Rao A".
export function markMe(authors: string): string {
  const esc = authors.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = site.name.trim().split(/\s+/);
  if (parts.length < 2) return esc;
  const first = parts[0]!, last = parts[parts.length - 1]!, i = first[0]!;
  const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [site.name.trim(), `${i}. ${last}`, `${i} ${last}`, `${last}, ${i}.`, `${last} ${i}`].map(re);
  return esc.replace(new RegExp(`(?<![\\w])(${forms.join("|")})(?![\\w])`), '<b class="me">$1</b>');
}

export async function writing() {
  const all = await getCollection("writing", (e) => !e.data.draft);
  for (const e of all) {
    e.data.title = smart(e.data.title);
    if (e.data.blurb) e.data.blurb = smart(e.data.blurb);
  }
  return all.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

// A piece's description for search results and link previews: its blurb, or else the opening of its
// first paragraph, so nobody has to write one.
export function summary(post: { body?: string; data: { blurb?: string } }): string {
  if (post.data.blurb) return post.data.blurb;
  const para = (post.body ?? "").split(/\n\s*\n/).map((s) => s.trim())
    .find((s) => s && !/^(#|>|```|\||!\[|\d+\.\s|[-*+]\s|\[\^)/.test(s)) ?? "";
  const text = smart(para.replace(/\[\^[^\]]+\]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim());
  return text.length <= 160 ? text : text.slice(0, 157).replace(/\s+\S*$/, "") + "…";
}

// The page changed most recently gets a dot in the menu, and the site's "Updated" date.
export async function freshness() {
  const w = await writing();
  const candidates: [string, string][] = [];
  if (now.show) candidates.push(["now", now.updated]);
  if (w[0]) candidates.push(["writing", iso(w[0].data.date)]);
  candidates.sort((a, b) => b[1].localeCompare(a[1]));
  return candidates[0] ? { page: candidates[0][0], date: candidates[0][1] } : { page: "", date: iso(new Date(build.builtAt)) };
}

// Social links (rail and phone footer). Web links open in a new tab; email stays in place. X is shown
// as its 𝕏 mark, with "X" kept for screen readers.
export const social = () => site.social.map((l) => {
  const web = /^https?:/.test(l.url);
  const x = /^(x|twitter)$/i.test(l.label.trim());
  const label = x ? `<span aria-hidden="true">𝕏</span><span class="vh">X</span>` : l.label;
  return `<a href="${l.url}"${web ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}${web ? '<span class="vh"> (opens in a new tab)</span>' : ""}</a>`;
}).join("");
