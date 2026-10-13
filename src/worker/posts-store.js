// One sync of the owner's Medium and Substack feeds, and the slice the pages read. Called from the
// PostSync Durable Object (posts-object.js). Each source is kept on its own, so a feed that fails
// one run keeps its last good posts while the other is refreshed.
//
// Object storage:  src:medium, src:substack   the posts of each feed, as last read
// KV:              posts:<name>               the view, which /writing/elsewhere.json reads

import { SOURCES, parsePosts } from "./core/posts.js";
import { UA } from "./core/sync.js";

export const REFRESH_MS = 12 * 3600e3;
export const RETRY_MS = 3600e3; // after a failed run
const VIEW_POSTS = 100;

// One name for one pair of feeds: a changed setting is a new object and a new KV key.
export const postsName = (sources) => SOURCES.map((k) => sources[k]?.feed || "").join("|");

export const freshMeta = (sources) => ({ version: 1, name: postsName(sources), sources, syncedAt: null, lastRun: null });

export async function fetchFeed(url, f = fetch) {
  const res = await f(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" } });
  const type = res.headers.get("content-type") || "";
  const xml = await res.text();
  if (!res.ok || !xml.includes("<rss")) {
    const e = new Error(`${new URL(url).hostname} answered ${res.status}`);
    Object.assign(e, { status: res.status, type, url, sample: xml.slice(0, 200) });
    throw e;
  }
  return xml;
}

// What the page gets: every source that has ever synced, and the posts newest first.
export function buildView(meta, kept, report) {
  const sources = {};
  let posts = [];
  for (const k of SOURCES) {
    const s = meta.sources[k];
    if (!s) continue;
    const got = kept[k];
    sources[k] = { url: s.url, feed: s.feed, name: got?.name ?? null, image: got?.image ?? null, count: got?.posts.length ?? 0, at: got?.at ?? null };
    if (got) posts = posts.concat(got.posts);
  }
  posts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { syncedAt: meta.syncedAt, lastRun: report, sources, posts: posts.slice(0, VIEW_POSTS) };
}

// Reads each feed, keeps what it got, then writes the view. A source that fails keeps its old posts.
export async function runPosts(env, storage, meta, trigger, f = fetch) {
  const started = Date.now();
  const report = { ok: true, trigger, at: new Date(started).toISOString(), sources: {} };
  const kept = {};
  for (const k of SOURCES) {
    const s = meta.sources[k];
    if (!s) continue;
    const t = Date.now();
    try {
      const xml = await fetchFeed(s.feed, f);
      const got = parsePosts(k, xml);
      kept[k] = { ...got, at: report.at };
      await storage.put(`src:${k}`, kept[k]);
      report.sources[k] = { ok: true, posts: got.posts.length, kb: Math.round(xml.length / 1024), ms: Date.now() - t };
    } catch (e) {
      kept[k] = (await storage.get(`src:${k}`)) || null;
      report.sources[k] = { ok: false, error: e.message, status: e.status, sample: e.sample, kept: kept[k]?.posts.length ?? 0, ms: Date.now() - t };
      report.ok = false;
    }
  }
  // The run counts as a sync if any source was read; a run where every source failed keeps the old time.
  if (Object.values(report.sources).some((r) => r.ok)) meta.syncedAt = report.at;
  report.wallMs = Date.now() - started;
  meta.lastRun = report;
  const view = buildView(meta, kept, report);
  await env.BOOKS.put(`posts:${meta.name}`, JSON.stringify(view));
  return view;
}
