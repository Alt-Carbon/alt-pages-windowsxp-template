// Regenerates the sample bookshelf shown until a site connects its own Goodreads profile, from a real
// public profile, with the same code the site's Worker runs. Default: Adithya (id 19054312).
// Usage: npm run sample:shelf [-- <goodreads id or profile URL>]
//
// Writes public/reading/view.json (what the pages read first) and public/reading/books.json (every book).
// Covers point straight at Goodreads' image servers so the sample also works under `astro dev`, which
// has no Worker to serve /reading/covers.
import { writeFileSync } from "node:fs";
import { PAGE_SIZE, coverPath, coverSource, userIdFrom } from "../src/worker/core/feed.js";
import { fetchPage } from "../src/worker/core/sync.js";
import { fetchProfile } from "../src/worker/core/profile.js";
import { buildView } from "../src/worker/store.js";

const userId = userIdFrom(process.argv[2] || "19054312");
if (!userId) throw new Error("Give a Goodreads id or profile URL.");

const page = async (shelf, n) => (await fetchPage({ userId, shelf, page: n })).books.map((b) => ({ ...b, status: shelf }));
const reading = await page("currently-reading", 1);
const read = [];
for (let n = 1; n <= 20; n++) {
  const books = await page("read", n);
  read.push(books);
  process.stdout.write(`read page ${n}: ${books.length} books\n`);
  if (books.length < PAGE_SIZE) break;
}
const profile = await fetchProfile({ userId }).catch(() => null);

const summary = (books) => {
  const years = {};
  for (const b of books) { const y = b.readAt ? b.readAt.slice(0, 4) : "undated"; years[y] = (years[y] || 0) + 1; }
  return { count: books.length, years };
};
const meta = { userId, profile, syncedAt: new Date().toISOString(), chunks: Object.fromEntries(read.map((b, i) => [i + 1, summary(b)])) };
const direct = (cover) => { const p = coverPath(cover); return p ? coverSource(p) : null; };

const view = buildView(meta, reading, read.flat(), null);
// view.json covers are this site's /reading/covers/<stamp>/<id>.jpg; point them at Goodreads instead.
for (const b of [...view.reading, ...view.read]) b.cover = b.cover && coverSource(b.cover.slice("/reading/covers/".length, -".jpg".length));
const out = { sample: true, ...view, lastRun: undefined };
writeFileSync("public/reading/view.json", JSON.stringify(out) + "\n");

const all = [...reading, ...read.flat()].map((b) => ({ ...b, cover: direct(b.cover) }));
writeFileSync("public/reading/books.json", JSON.stringify({ version: 3, source: "goodreads", sample: true, userId, books: all }) + "\n");

const kb = (f) => Math.round(Buffer.byteLength(JSON.stringify(f)) / 1024);
console.log(`${profile?.name ?? userId}: ${reading.length} reading, ${all.length - reading.length} read; view.json ${kb(out)} KB, books.json ${kb({ books: all })} KB`);
