// When the weekly update runs, and the editor's "Update now".
//
//   cron (twice a day)      at most once a week: act as the site's own GitHub App (its key is in
//                           KV, see auth.js) and run src/worker/update.js
//   GET  /auth/update       { last, automatic }: the last run, and whether weekly runs can happen
//   POST /auth/update       run it now with the signed-in person's GitHub token
//                           (Authorization: Bearer …), for sites whose app predates the key

import { readApp } from "./auth.js";
import { installationToken } from "./github-app.js";
import { runUpdate } from "./update.js";

export const LAST_KEY = "update:last";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Which repository and template, from the build (public/hello/config.json).
async function where(env) {
  try {
    const res = await env.ASSETS.fetch("https://assets.local/hello/config.json");
    const c = res.ok ? await res.json() : {};
    return { repo: c.repo || "", templateRepo: c.templateRepo || "" };
  } catch {
    return { repo: "", templateRepo: "" };
  }
}

async function record(env, by, run) {
  let out;
  try { out = { ok: true, ...(await run()) }; } catch (e) { out = { ok: false, changed: false, reason: e.message }; }
  const last = { at: new Date().toISOString(), by, ...out };
  await env.BOOKS.put(LAST_KEY, JSON.stringify(last));
  return last;
}

export async function weekly(env, { now = Date.now(), fetch: f = fetch } = {}) {
  const last = await env.BOOKS.get(LAST_KEY, "json").catch(() => null);
  if (last && now - Date.parse(last.at) < WEEK - 12 * 60 * 60 * 1000) return null;
  const app = await readApp(env);
  if (!app?.pem || !app?.app_id) return null; // set up before 17 Nov 2026: the editor's "Update now" still works
  const { repo, templateRepo } = await where(env);
  return record(env, "weekly", async () => runUpdate({ token: await installationToken({ appId: app.app_id, pem: app.pem, repo, fetch: f }), repo, templateRepo, fetch: f }));
}

export async function updateRoute(request, env, { fetch: f = fetch } = {}) {
  if (request.method === "GET" || request.method === "HEAD") {
    const app = await readApp(env);
    return json({ last: await env.BOOKS.get(LAST_KEY, "json").catch(() => null), automatic: !!(app?.pem && app?.app_id) });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  const token = (/^Bearer (\S+)$/.exec(request.headers.get("authorization") || "") || [])[1];
  if (!token) return json({ error: "Sign in first." }, 401);
  const { repo, templateRepo } = await where(env);
  return json(await record(env, "editor", () => runUpdate({ token, repo, templateRepo, fetch: f })));
}
