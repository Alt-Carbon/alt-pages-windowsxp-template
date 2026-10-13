// What the desktop draws, worked out once per build from the same content files the other templates
// use: the plain text Notepad shows for About and Now, the icons, the facts in System Properties, and
// the small piece of data the page's script reads (src/scripts/desktop/main.js).
import { readdirSync } from "node:fs";
import { about, accent, day, freshness, now, research, shown, site, writing, writingPage, years } from "./content";
import { WALLPAPERS } from "./schemas";

export const first = site.name.trim().split(/\s+/)[0] || site.name;

// Inline Markdown as plain text for Notepad: links keep their words, and their address unless it's an email.
export const plain = (s: string) =>
  s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => (u.startsWith("mailto:") ? t : `${t} <${u}>`))
    .replace(/\*\*/g, "").replace(/\*/g, "");

// about.txt: headings are lines of their own, columns are tab stops (Notepad sets a wide tab).
export function aboutText(): string {
  const L: string[] = [site.name, ""];
  for (const p of about.paragraphs) L.push(plain(p), "");
  if (about.experience.length) {
    L.push("Experience");
    for (const e of about.experience) {
      L.push(`${years(e).replace(" – ", "–")}\t${e.role}, ${e.org}`);
      if (e.summary) L.push(`\t${plain(e.summary)}`);
    }
    L.push("");
  }
  if (about.contact) L.push("Contact", plain(about.contact), "");
  if (about.facts.length) L.push(...about.facts.map((f) => `${f.label}\t${plain(f.value)}`), "");
  if (about.shortBio) L.push("Short bio", about.shortBio, "");
  return L.join("\n").trimEnd() + "\n";
}

// now.txt
export function nowText(): string {
  const L: string[] = ["Now", `Updated ${day(now.updated)}`, ""];
  for (const g of now.groups) L.push(g.heading, ...g.items.map((i) => `•\t${plain(i)}`), "");
  L.push("This is a now page <https://nownownow.com/about>.");
  return L.join("\n");
}

// Where the owner is, for their local time and weather on the taskbar.
export const city = (site.desktop.city || about.facts.find((f) => /^based/i.test(f.label))?.value || site.place || "").trim();

export type Icon = { key: string; label: string; ico: string; href?: string; doc?: string; full?: string };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// Desktop icons in order. A window whose page is switched off or empty has no icon. Pinned pieces of
// writing get an icon of their own. My Computer has no page, so no address.
export async function icons(): Promise<Icon[]> {
  const on = await shown();
  const posts = await writing();
  const list: Icon[] = [{ key: "about", label: "about.txt", ico: "txt", href: "/about" }];
  if (on.has("writing")) list.push({ key: "writing", label: "Writing", ico: "journal", href: "/writing" });
  if (on.has("research")) list.push({ key: "research", label: "Research", ico: "folder", href: "/research" });
  if (on.has("reading")) list.push({ key: "reading", label: "Reading", ico: "books", href: "/reading" });
  if (on.has("now")) list.push({ key: "now", label: "now.txt", ico: "txt", href: "/now" });
  for (const slug of site.desktop.pinned) {
    const p = posts.find((x) => x.id === slug && !x.data.link);
    if (p) list.push({ key: "writing", label: clip(p.data.title, 24), full: p.data.title, ico: "txt", href: `/writing/${p.id}`, doc: p.id });
  }
  list.push({ key: "computer", label: "My Computer", ico: "pc" });
  return list;
}

// System Properties: a few true numbers about the site.
export async function stats() {
  const posts = await writing();
  const words = posts.reduce((n, p) => n + (p.body ?? "").split(/\s+/).filter(Boolean).length, 0);
  const firstPiece = posts.length ? posts[posts.length - 1]!.data.date.toISOString().slice(0, 10) : now.updated;
  const fresh = await freshness();
  return { pieces: posts.length, words, research: research.items.length, installed: day(firstPiece), updated: day(fresh.date) };
}


// Real wallpaper photos, when the owner adds them: a file at public/media/wallpapers/<name>.jpg (or png,
// webp) stands in for the painted <name>. The template ships none: XP's own wallpapers are Microsoft's.
export function photos(): Record<string, string> {
  const out: Record<string, string> = {};
  let files: string[] = [];
  try { files = readdirSync("public/media/wallpapers"); } catch { return out; }
  for (const key of WALLPAPERS) {
    const f = files.find((x) => /\.(jpe?g|png|webp)$/i.test(x) && x.replace(/\.[^.]+$/, "").toLowerCase() === key);
    if (f) out[key] = `/media/wallpapers/${f}`;
  }
  return out;
}

// What the page's script needs that isn't in the markup.
export async function deskData() {
  const posts = await writing();
  const d = site.desktop;
  return {
    name: site.name, first, greeting: site.greeting, oneLiner: site.oneLiner,
    updated: now.updated, city: d.weather ? city : "",
    notes: d.notes, boot: d.boot, wallpaper: d.wallpaper, picture: d.picture, photos: photos(),
    accent: accent.light,
    titles: posts.map((p) => p.data.title),
    writing: posts.map((p) => ({ slug: p.id, title: p.data.title, date: p.data.date.toISOString().slice(0, 10), link: p.data.link || "" })),
    hide: writingPage.hide,   // Medium or Substack posts to leave out of the journal
  };
}
