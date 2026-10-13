// This site's Worker. The pages are static assets; the script owns /reading, where the owner's
// Goodreads shelves are kept, and stamps the site's own address into pages and feeds (see stamp()).
// The sync itself runs in the ShelfSync Durable Object (sync-object.js).
//
// GET  /reading/view.json         the shelf, for the Reading page and the home page
// GET  /reading/books.json        every book synced so far
// GET  /reading/status            the object's report: last run, next alarm
// POST /reading/sync              run a sync now (at most one every 30 s)
// GET  /reading/covers/<stamp>/<id>.jpg   a cover, fetched from Goodreads once and kept
// cron                            a nudge every 12 hours; the object's own alarm is the real schedule
//
// Which profile: scripts/prepare.mjs writes the Goodreads id from content/site.json
// to /reading/config.json at build time, so changing it in the editor is an
// ordinary publish. With no profile, the sample shelf in public/ is served.
//
// The same again for the owner's Medium and Substack posts, under /writing/elsewhere
// (the PostSync object, posts-object.js; the feeds named in /writing/elsewhere/config.json):
//
// GET  /writing/elsewhere.json         the posts, for the Writing page and the home page
// GET  /writing/elsewhere/status       the object's report
// POST /writing/elsewhere/sync         run a sync now

import { coverSource } from "./core/feed.js";
import { UA } from "./core/sync.js";
import { allBooks } from "./store.js";
import { postsName } from "./posts-store.js";

export { ShelfSync } from "./sync-object.js";
export { PostSync } from "./posts-object.js";

const BASE = "/reading";
const POSTS = "/writing/elsewhere";
const YEAR = "public, max-age=31536000, immutable";
const SYNC_GAP = 30 * 1000;
const CONFIG_TTL = 60 * 1000;

const json = (body, status = 200, cache = "no-store") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });

// Pages, feeds and the sitemap are built without knowing the site's address (everyone deploys to
// their own account and may add a domain later), so they carry ORIGIN_TOKEN wherever an absolute
// address is needed: canonical links, link previews, RSS, the sitemap. This swaps in the address
// the visitor used. wrangler.jsonc routes only those files through the Worker; images, scripts and
// the editor are served straight from the assets.
const ORIGIN_TOKEN = "https://__origin__";
const STAMPED = /^(text\/html|text\/plain|application\/xml|text\/xml|application\/rss\+xml|application\/ld\+json)/;
async function stamp(request, res) {
  if (!(res.ok || res.status === 404) || !STAMPED.test(res.headers.get("content-type") || "")) return res;
  const body = await res.text();
  if (!body.includes(ORIGIN_TOKEN)) return new Response(body, res);
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  return new Response(body.replaceAll(ORIGIN_TOKEN, new URL(request.url).origin), { status: res.status, statusText: res.statusText, headers });
}

const age = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);
const object = (env, userId) => env.SYNC.get(env.SYNC.idFromName(userId));

// The built config, cached per isolate for a minute.
let config = { at: 0, userId: null };
async function profileId(env, request) {
  if (Date.now() - config.at < CONFIG_TTL) return config.userId;
  let userId = null;
  try {
    const res = await env.ASSETS.fetch(new URL(`${BASE}/config.json`, request.url));
    if (res.ok) userId = (await res.json()).userId || null;
  } catch {
    /* no config: no profile */
  }
  config = { at: Date.now(), userId };
  return userId;
}

// Which feeds the posts sync follows, from the built config, cached per isolate for a minute.
// Null when neither Medium nor Substack is set.
let postsConfig = { at: 0, sources: null };
async function postSources(env, request) {
  if (Date.now() - postsConfig.at < CONFIG_TTL) return postsConfig.sources;
  let sources = null;
  try {
    const res = await env.ASSETS.fetch(new URL(`${POSTS}/config.json`, request.url));
    if (res.ok) {
      const c = await res.json();
      if (c.medium || c.substack) sources = { medium: c.medium || null, substack: c.substack || null };
    }
  } catch {
    /* no config: no sources */
  }
  postsConfig = { at: Date.now(), sources };
  return sources;
}

// /writing/elsewhere.json and the routes under it.
async function posts(request, env, ctx, url) {
  const path = url.pathname.slice(POSTS.length).replace(/\/$/, "");
  const sources = await postSources(env, request);
  // Nothing connected: the sample posts in public/, and the config file itself.
  if (!sources) {
    if (path === "/status") return json({ sources: null, syncedAt: null });
    if (path === "/sync") return json({ error: "No Medium or Substack address is set. Add one in the editor under Site settings." }, 409);
    return env.ASSETS.fetch(request);
  }
  const name = postsName(sources);
  const stub = env.POSTS.get(env.POSTS.idFromName(name));

  if (path === "/sync") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    const st = await stub.status();
    const started = !st.running && age(st.lastRun?.at) > SYNC_GAP ? await stub.kick(sources, "sync now", true) : "too soon";
    return json({ started, status: st });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (path === "/status") return json({ sources, ...(await stub.status()) });
  if (path === ".json") {
    const view = (await env.BOOKS.get(`posts:${name}`, "json")) || (await stub.view());
    if (view) return json(view, 200, "public, max-age=300");
    const st = await stub.status();
    if (!st.running && !st.lastRun) ctx.waitUntil(stub.kick(sources, "first visit"));
    return json({ syncing: true, syncedAt: null, lastRun: st.lastRun, sources: {}, posts: [] }, 200, "no-store");
  }
  return env.ASSETS.fetch(request);
}

// Serves an image from KV, fetching it from Goodreads the first time.
async function image(env, ctx, key, source) {
  const kept = await env.BOOKS.getWithMetadata(key, "arrayBuffer");
  if (kept.value) return new Response(kept.value, { headers: { "content-type": kept.metadata?.type || "image/jpeg", "cache-control": YEAR } });
  const res = await fetch(source, { headers: { "user-agent": UA, accept: "image/*" } });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.startsWith("image/")) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=3600" } });
  const bytes = await res.arrayBuffer();
  ctx.waitUntil(env.BOOKS.put(key, bytes, { metadata: { type } }));
  return new Response(bytes, { headers: { "content-type": type, "cache-control": YEAR } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === `${POSTS}.json` || url.pathname.startsWith(`${POSTS}/`)) return posts(request, env, ctx, url);
    if (!url.pathname.startsWith(`${BASE}/`)) return stamp(request, await env.ASSETS.fetch(request));
    const path = url.pathname.slice(BASE.length).replace(/\/$/, "");

    const cover = /^\/covers\/(\d+[a-z]?\/\d+)\.jpg$/.exec(path);
    if (cover) return image(env, ctx, `img:cover:${cover[1]}`, coverSource(cover[1]));

    const userId = await profileId(env, request);
    // No profile connected: the sample shelf and the other static files under /reading.
    if (!userId) {
      if (path === "/status") return json({ profile: null, syncedAt: null });
      if (path === "/sync") return json({ error: "No Goodreads profile is set. Add one in the editor under Site settings." }, 409);
      return env.ASSETS.fetch(request);
    }
    const stub = object(env, userId);

    if (path === "/sync") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      const st = await stub.status();
      const started = !st.running && age(st.lastRun?.at) > SYNC_GAP ? await stub.kick(userId, "sync now", "refresh") : "too soon";
      return json({ started, status: st });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    if (path === "/status") return json({ profile: userId, ...(await stub.status()) });
    if (path === "/books.json") {
      const st = await stub.status();
      return st.syncedAt ? json(await allBooks(env.BOOKS, userId, st.pages), 200, "public, max-age=300") : json({ error: "Not synced yet" }, 404);
    }
    if (path === "/view.json") {
      const view = (await env.BOOKS.get(`view:${userId}`, "json")) || (await stub.view());
      if (view) return json(view, 200, "public, max-age=300");
      // Nothing yet: start the first sync and say so.
      const st = await stub.status();
      if (!st.running && !st.lastRun) ctx.waitUntil(stub.kick(userId, "first visit", "walk"));
      return json({ userId, syncing: true, syncedAt: null, lastRun: st.lastRun, reading: [], read: [] }, 200, "no-store");
    }
    return env.ASSETS.fetch(request);
  },

  // The object keeps its own alarm. The cron only makes sure a profile that was
  // set while nothing visited the site still gets its first sync.
  async scheduled(event, env) {
    const res = await env.ASSETS.fetch("https://assets.local/reading/config.json").catch(() => null);
    const userId = res?.ok ? (await res.json()).userId : null;
    if (userId) await object(env, userId).kick(userId, `cron ${event.cron}`);
    const sources = await postSources(env, new Request("https://assets.local/"));
    if (sources) await env.POSTS.get(env.POSTS.idFromName(postsName(sources))).kick(sources, `cron ${event.cron}`);
  },
};
