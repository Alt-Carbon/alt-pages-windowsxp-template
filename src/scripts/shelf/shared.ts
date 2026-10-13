// What every bookshelf style shares: the data (from the site's own reading sync, or the sample shipped
// in public/ until a Goodreads profile is connected), colours sampled from the covers, grouping, and
// small formatting helpers. The styles themselves live beside this file, one module each.

// Everything the sync keeps per book (src/worker/store.js slim()). Older views lack the later fields.
export type Book = {
  id: string; title: string; author: string; cover: string | null; rating: number | null; avgRating?: number | null;
  readAt: string | null; addedAt?: string | null; shelves: string[]; review: string | null; reviewUrl?: string | null;
  pages?: number | null; published?: number | null; isbn?: string | null; url: string;
  now?: boolean; // currently reading
};
export type View = {
  sample?: boolean; syncing?: boolean; syncedAt: string | null; reading: Book[]; read: Book[];
  profile?: { url?: string; name?: string | null; image?: string | null } | null;
  counts?: { reading: number; read: number; perYear?: Record<string, number> };
};
export type Shelf = { view: View; reading: Book[]; read: Book[]; books: Book[]; complete: boolean; owner: string };

// A style renders into `root` and returns how many books it showed (for the tab's count).
export type Style = (shelf: Shelf, root: HTMLElement) => number;

export const NOW = "Reading now";

// ---------- data ----------
export async function load(): Promise<View | null> {
  try {
    const r = await fetch("/reading/view.json", { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as View;
  } catch {
    return null;
  }
}

type Raw = Book & { status?: string };
// Every book, from /reading/books.json (the whole shelf as the sync stored it), brought into the same
// shape as view.json. Without it (the sample before a sync, or an old deploy) the view's slice is used.
export async function loadAll(view: View): Promise<Shelf> {
  const owner = view.profile?.name?.split(" ")[0] || "";
  const done = (reading: Book[], read: Book[], complete: boolean): Shelf => {
    for (const b of reading) b.now = true;
    return { view, reading, read, books: [...reading, ...read], complete, owner };
  };
  try {
    const r = await fetch("/reading/books.json", { headers: { accept: "application/json" } });
    if (r.ok) {
      const { books, sample } = (await r.json()) as { books: Raw[]; sample?: boolean };
      // A synced shelf serves covers from this site; the sample links Goodreads' images directly.
      const norm = (b: Raw): Book => {
        const m = /\/books\/(\d+[a-z]?)\/(\d+)\./.exec(b.cover || "");
        const cover = sample ? b.cover : m ? `/reading/covers/${m[1]}/${m[2]}.jpg` : null;
        return { ...b, cover, shelves: (b.shelves || []).filter((s) => s !== "read" && s !== "currently-reading") };
      };
      const seen = new Set<string>();
      const all = books.filter((b) => !seen.has(b.id) && seen.add(b.id));
      const now = (b: Raw) => b.status === "currently-reading";
      const read = all.filter((b) => !now(b)).map(norm)
        .sort((a, b) => (b.readAt || b.addedAt || "").localeCompare(a.readAt || a.addedAt || ""));
      return done(all.filter(now).map(norm), read, true);
    }
  } catch {}
  return done([...view.reading], [...view.read], false);
}

// ---------- text ----------
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (iso: string | null | undefined) => (iso ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : "");
export const monthYear = (iso: string | null | undefined) => (iso ? `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : "");
export const year = (b: Book) => (b.readAt ? b.readAt.slice(0, 4) : null);
export const human = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
export const short = (t: string) => t.split(/[:(]/)[0]!.trim();
// The first author's surname, skipping suffixes like Jr. or PhD.
export const surname = (a: string) => {
  const parts = a.split(/,| and /)[0]!.trim().split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|iv|phd|md)\.?$/i.test(w));
  return parts[parts.length - 1] || "";
};
export const small = (url: string | null) => (url ? url.replace(/\._S[XY]\d+_\./, "._SX98_.") : null);
export const n = (x: number) => x.toLocaleString("en");
export function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
export const stars = (r: number) => `<span class="stars" role="img" aria-label="Rated ${r} out of 5">${"★".repeat(r)}<i>${"★".repeat(5 - r)}</i></span>`;
export const paragraphs = (text: string) => text.split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
export const excerpt = (text: string, max = 240) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).replace(/[,;:]$/, "") + "…";
};
// Links out: the book on Goodreads for every book, its review when there is one. New tab, as the site's
// other outbound links.
export const links = (b: Book) => [
  `<a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">View on Goodreads<span class="vh"> (opens in a new tab)</span></a>`,
  b.reviewUrl && b.review ? `<a href="${esc(b.reviewUrl)}" target="_blank" rel="noopener noreferrer">Review on Goodreads<span class="vh"> (opens in a new tab)</span></a>` : "",
].filter(Boolean);
// The facts a style can list; only the ones a book has.
export const facts = (b: Book): [string, string][] => ([
  ["Read", day(b.readAt)], ["Added", day(b.addedAt)], ["Pages", b.pages ? n(b.pages) : ""], ["First published", b.published ? String(b.published) : ""],
  ["Goodreads avg", b.avgRating ? b.avgRating.toFixed(2) : ""], ["ISBN", b.isbn || ""],
] as [string, string][]).filter(([, v]) => v);

// ---------- grouping ----------
export type GroupBy = "year" | "shelf";
// Reading now first, then years newest first (or the person's own Goodreads shelves, largest first),
// with the catch-all last.
export function groups(books: Book[], by: GroupBy = "year"): [string, Book[]][] {
  const g = new Map<string, Book[]>();
  const add = (k: string, b: Book) => (g.get(k) || g.set(k, []).get(k)!).push(b);
  for (const b of books) {
    if (b.now) add(NOW, b);
    else if (by === "year") add(year(b) || "Not dated", b);
    else add(b.shelves?.[0] ? human(b.shelves[0]) : "Everything else", b);
  }
  const rank = (k: string) => (k === NOW ? -2 : k === "Not dated" || k === "Everything else" ? 2 : 0);
  return [...g.entries()].sort(([a, x], [b, z]) => rank(a) - rank(b) || (by === "year" ? b.localeCompare(a) : z.length - x.length));
}
export const usesShelves = (books: Book[]) => books.some((b) => b.shelves?.length);

// ---------- cover colours ----------
// The left edge of a cover is the closest thing to its spine. Sampled in the visitor's browser from the
// small cover (Goodreads' image servers allow it; the site's own /reading/covers are same-origin), so it
// costs the site nothing. Only books that come near the screen are sampled, and the results are kept in
// this browser, so a second visit downloads and computes nothing for colours.
export type RGB = [number, number, number];
export const colour = new Map<string, RGB | null>();
export const lum = ([r, g, b]: RGB) => { const f = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const hex = (rgb: RGB) => "#" + rgb.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
export const textOn = (rgb: RGB) => (lum(rgb) > 0.36 ? "#141414" : "#f6f3ec");
// Placeholder cloth until the cover is sampled, or for books without one.
const CLOTH: RGB[] = [[31, 42, 54], [184, 134, 43], [228, 222, 208], [39, 53, 77], [109, 90, 126], [59, 59, 56], [31, 59, 46], [239, 227, 200], [162, 59, 42], [217, 98, 43], [53, 73, 94], [47, 111, 167], [74, 74, 47], [201, 123, 109], [156, 148, 129], [75, 29, 42]];
export const cloth = (b: Book): RGB => CLOTH[hash(b.title + b.author) % CLOTH.length]!;
export const rgbOf = (b: Book): RGB => colour.get(b.id) || cloth(b);
export const paint = (el: HTMLElement, rgb: RGB) => { el.style.setProperty("--c", hex(rgb)); el.style.setProperty("--t", textOn(rgb)); };

const STORE = "shelf-colours-v1";
try {
  for (const [id, rgb] of Object.entries(JSON.parse(localStorage.getItem(STORE) || "{}"))) colour.set(id, rgb as RGB);
} catch {}
// Written at most once a second while colours arrive, and when the page is left.
let saving = 0;
function write() {
  saving = 0;
  try {
    const out: Record<string, RGB> = {};
    for (const [id, rgb] of colour) if (rgb) out[id] = rgb.map(Math.round) as RGB;
    localStorage.setItem(STORE, JSON.stringify(out));
  } catch {}
}
function save() {
  if (!saving) saving = window.setTimeout(write, 1000);
}
addEventListener("pagehide", () => { if (saving) { clearTimeout(saving); write(); } });

function sample(b: Book, root: ParentNode): Promise<void> {
  if (!b.cover || colour.has(b.id)) return Promise.resolve();
  colour.set(b.id, null);
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = 12; cv.height = 18;
        const x = cv.getContext("2d", { willReadFrequently: true })!;
        x.drawImage(img, 0, 0, 12, 18);
        const d = x.getImageData(0, 0, 3, 18).data;
        let r = 0, g = 0, bl = 0, k = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]!; g += d[i + 1]!; bl += d[i + 2]!; k++; }
        const rgb: RGB = [r / k, g / k, bl / k];
        colour.set(b.id, rgb);
        save();
        for (const el of root.querySelectorAll<HTMLElement>(`[data-id="${b.id}"]`)) paint(el, rgb);
      } catch {}
      res();
    };
    img.onerror = () => res();
    img.src = small(b.cover)!;
  });
}

// Paints every [data-id] element under root: known colours at once, the rest as each book comes within
// 300px of the screen (four downloads at a time). Elements receive --c and --t.
let watch: IntersectionObserver | null = null;
const books = new Map<string, Book>();
const queue: [Book, ParentNode][] = [];
let running = 0;
function pump() {
  while (running < 4 && queue.length) {
    const [b, root] = queue.shift()!;
    running++;
    sample(b, root).finally(() => { running--; pump(); });
  }
}
export function sampleAll(list: Book[], root: ParentNode = document) {
  for (const b of list) books.set(b.id, b);
  watch ??= new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      watch!.unobserve(e.target);
      const b = books.get((e.target as HTMLElement).dataset.id!);
      if (b && !colour.has(b.id)) { queue.push([b, root]); pump(); }
    }
  }, { rootMargin: "300px" });
  for (const el of root.querySelectorAll<HTMLElement>("[data-id]")) {
    const rgb = colour.get(el.dataset.id!);
    if (rgb) paint(el, rgb);
    else watch.observe(el);
  }
}

// ---------- page lifetime ----------
// Pages change in place (Astro's ClientRouter). Listeners on window or document take this signal, so
// they stop when the visitor leaves the page instead of piling up.
let life = new AbortController();
export const pageSignal = () => life.signal;
addEventListener("astro:before-swap", () => { life.abort(); life = new AbortController(); });

// ---------- misc ----------
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
