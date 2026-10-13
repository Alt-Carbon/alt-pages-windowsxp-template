// One sync run for one person, and the slice the pages read. The run is called
// from the ShelfSync Durable Object (sync-object.js), which has 30 s of CPU per
// request on every plan, so a whole shelf is read in one go. Results go to KV,
// which is what /reading/view.json reads: cheap, cached at the edge.
//
// Cycles:  refresh  the newest page of each shelf, every 12 hours
//          walk     every page of the read shelf plus the profile, on the first
//                   sync and weekly; a walk also drops books deleted on Goodreads
//
// KV keys:  shelf:<user>:reading    the currently-reading shelf
//           shelf:<user>:read:<n>   page n of the read shelf
//           view:<user>             the slice the pages need
//           img:<path>              covers and the profile picture, stored on first request

import { PAGE_SIZE, coverPath } from "./core/feed.js";
import { fetchPage } from "./core/sync.js";
import { fetchProfile } from "./core/profile.js";

export const REFRESH_MS = 12 * 3600e3;
export const WALK_MS = 7 * 86400e3;
export const RETRY_MS = 3600e3; // after a failed run
const PROFILE_MS = WALK_MS;
const VIEW_BOOKS = 200;

export const freshMeta = (userId) => ({ version: 3, userId, pages: 0, chunks: {}, profile: null, syncedAt: null, walkedAt: null, lastRun: null });

// A minute of slack, so an alarm set 12 hours after a run finds that run old enough.
const old = (iso, ms, now) => !iso || now - Date.parse(iso) > ms - 60e3;

// Which cycle a run should be now, if any.
export function due(meta, now = Date.now()) {
  if (meta.lastRun && !meta.lastRun.ok && !old(meta.lastRun.at, RETRY_MS, now)) return null;
  if (old(meta.walkedAt, WALK_MS, now)) return "walk";
  if (old(meta.syncedAt, REFRESH_MS, now)) return "refresh";
  return null;
}

const yearOf = (b) => (b.readAt ? b.readAt.slice(0, 4) : "undated");

const summary = (books) => {
  const years = {};
  for (const b of books) years[yearOf(b)] = (years[yearOf(b)] || 0) + 1;
  return { count: books.length, years };
};

// What the page gets per book: everything the feed has, reviews in full. Covers are served from
// this site (/reading/covers/<stamp>/<id>.jpg).
const slim = (b) => {
  const path = coverPath(b.cover);
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    cover: path ? `/reading/covers/${path}.jpg` : null,
    rating: b.rating,
    avgRating: b.avgRating ?? null,
    readAt: b.readAt,
    addedAt: b.addedAt ?? null,
    shelves: b.shelves.filter((s) => s !== "read" && s !== "currently-reading"),
    review: b.review ?? null,
    reviewUrl: b.reviewUrl ?? null,
    pages: b.pages ?? null,
    published: b.published ?? null,
    isbn: b.isbn ?? null,
    url: b.url,
  };
};

const newest = (a, b) => (b.readAt || b.addedAt || "").localeCompare(a.readAt || a.addedAt || "");

// The page's slice: what is being read now, the newest read, counts over every page.
export function buildView(meta, reading, first, report) {
  const perYear = {};
  let read = 0;
  for (const c of Object.values(meta.chunks)) {
    read += c.count;
    for (const [y, n] of Object.entries(c.years)) perYear[y] = (perYear[y] || 0) + n;
  }
  return {
    userId: meta.userId,
    profile: meta.profile,
    syncedAt: meta.syncedAt,
    lastRun: report,
    counts: { reading: reading.length, read, perYear },
    reading: [...reading].sort(newest).map(slim),
    read: [...first].sort(newest).slice(0, VIEW_BOOKS).map(slim),
  };
}

// Reads the shelves, then writes everything at once, so a failure changes nothing.
export async function runSync(env, meta, kind, trigger) {
  const kv = env.BOOKS;
  const userId = meta.userId;
  const started = new Date();
  const report = { ok: true, trigger, kind, at: started.toISOString(), pages: [] };
  const page = async (shelf, n) => {
    const got = await fetchPage({ userId, shelf, page: n });
    report.pages.push({ shelf, page: n, kb: Math.round(got.bytes / 1024), items: got.books.length });
    return got.books.map((b) => ({ ...b, status: shelf }));
  };

  try {
    const reading = await page("currently-reading", 1);
    const read = [];
    for (let n = 1; n <= 20; n++) {
      read.push(await page("read", n));
      if (read[n - 1].length < PAGE_SIZE || kind === "refresh") break;
    }
    const last = read.length;
    const short = read[last - 1].length < PAGE_SIZE;

    if (kind === "walk" || old(meta.profile?.at, PROFILE_MS, started.getTime())) {
      try {
        meta.profile = { ...(await fetchProfile({ userId })), at: report.at };
      } catch (e) {
        report.profileError = e.message;
      }
    }

    // Pages beyond the last one read are gone from Goodreads; a refresh only knows about page 1.
    const gone = short ? Object.keys(meta.chunks).map(Number).filter((n) => n > last) : [];
    for (const n of gone) delete meta.chunks[n];
    read.forEach((books, i) => (meta.chunks[i + 1] = summary(books)));
    meta.pages = short ? last : Math.max(meta.pages, last);
    meta.syncedAt = report.at;
    if (kind === "walk") meta.walkedAt = report.at;
    report.books = reading.length + Object.values(meta.chunks).reduce((n, c) => n + c.count, 0);
    report.wallMs = Date.now() - started.getTime();

    // The view shows the newest books across every page read this run, not only page 1.
    const view = buildView(meta, reading, read.flat(), report);
    await Promise.all([
      kv.put(`shelf:${userId}:reading`, JSON.stringify(reading)),
      ...read.map((books, i) => kv.put(`shelf:${userId}:read:${i + 1}`, JSON.stringify(books))),
      ...gone.map((n) => kv.delete(`shelf:${userId}:read:${n}`)),
      kv.put(`view:${userId}`, JSON.stringify(view)),
    ]);
    meta.lastRun = report;
    return view;
  } catch (e) {
    Object.assign(report, { ok: false, error: e.message, status: e.status, sample: e.sample, wallMs: Date.now() - started.getTime() });
    meta.lastRun = report;
    return null;
  }
}

// Every book, as one JSON document, spliced from the stored pages without parsing them.
export async function allBooks(kv, userId, pages) {
  const keys = [`shelf:${userId}:reading`, ...Array.from({ length: pages }, (_, i) => `shelf:${userId}:read:${i + 1}`)];
  const parts = (await Promise.all(keys.map((k) => kv.get(k)))).filter((s) => s && s.length > 2).map((s) => s.slice(1, -1));
  return `{"version":3,"source":"goodreads","userId":"${userId}","books":[${parts.join(",")}]}`;
}
