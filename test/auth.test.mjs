import { test } from "node:test";
import assert from "node:assert/strict";
import { auth, manifest, popupHtml, repoFromConfig, sameLogin } from "../src/worker/auth.js";

const ORIGIN = "https://asha.example.workers.dev";

// A Worker environment with an in-memory KV and a config.yml that names the repository.
const fakeEnv = ({ repo = "asha/asha-site", app = null } = {}) => {
  const kv = new Map(app ? [["auth:app", JSON.stringify(app)]] : []);
  return {
    kv,
    BOOKS: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) },
    ASSETS: { fetch: async () => new Response(`backend:\n  name: github\n  repo: ${repo}\n  branch: main\n`, { headers: { "content-type": "text/yaml" } }) },
  };
};
const req = (path, headers = {}) => new Request(`${ORIGIN}${path}`, { headers });
const run = (env, path, headers) => auth(req(path, headers), env, new URL(`${ORIGIN}${path}`));
const cookieOf = (res, name) => (res.headers.get("set-cookie") || "").match(new RegExp(`${name}=([^;]+)`))?.[1];

test("manifest describes a private app with contents: write, named after the repository", () => {
  const m = manifest(ORIGIN, "asha/asha-site");
  assert.equal(m.name, "asha-site sign-in");
  assert.equal(m.public, false);
  assert.deepEqual(m.default_permissions, { contents: "write", metadata: "read" });
  assert.equal(m.redirect_url, `${ORIGIN}/auth/setup/done`);
  assert.deepEqual(m.callback_urls, [`${ORIGIN}/callback`]);
  assert.ok(manifest(ORIGIN, "x/a-very-long-repository-name-indeed-yes").name.length <= 34);
  assert.equal(manifest(ORIGIN, "").name, "asha.example.workers.dev sign-in");
});

test("repoFromConfig reads owner/name and refuses the placeholder", () => {
  assert.equal(repoFromConfig("backend:\n  name: github\n  repo: Asha/site.v2\n"), "Asha/site.v2");
  assert.equal(repoFromConfig("backend:\n  repo: OWNER/REPO\n"), "");
  assert.equal(repoFromConfig("nothing here"), "");
  assert.equal(repoFromConfig("repo: not a repo\n"), "");
  assert.ok(sameLogin("Asha", "asha"));
  assert.ok(!sameLogin("", "asha"));
});

test("the popup page sends a token to this site's origin only, and errors to anyone", () => {
  const ok = popupHtml(ORIGIN, { token: "ghu_abc" });
  assert.ok(ok.includes(`const own = "${ORIGIN}"`));
  assert.ok(ok.includes("if (hasToken && origin !== own) return;"));
  assert.ok(ok.includes('"authorization:github:success:"'));
  assert.ok(ok.includes("ghu_abc"));
  const bad = popupHtml(ORIGIN, { error: "nope", errorCode: "CSRF_DETECTED" });
  assert.ok(bad.includes("const hasToken = false"));
  assert.ok(bad.includes('"authorization:github:error:"'));
});

test("/auth with no app yet shows the setup page with a manifest form and a state cookie", async () => {
  const res = await run(fakeEnv(), "/auth?provider=github&site_id=asha.example.workers.dev&scope=repo");
  assert.equal(res.status, 200);
  const body = await res.text();
  const state = cookieOf(res, "auth-setup-state");
  assert.ok(state && state.length >= 32);
  assert.ok(body.includes(`action="https://github.com/settings/apps/new?state=${state}"`));
  assert.ok(body.includes("name=&quot;manifest&quot;".replace(/&quot;/g, '"')));
  assert.ok(body.includes("asha-site sign-in"));
  assert.ok(body.includes("no sign-in app yet"));
});

test("/auth with an app redirects to GitHub with a csrf state cookie; /callback checks it", async () => {
  const env = fakeEnv({ app: { client_id: "Iv1.abc", client_secret: "s", slug: "asha-site-sign-in", owner: "asha" } });
  const res = await run(env, "/auth?provider=github&site_id=asha.example.workers.dev");
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), "Iv1.abc");
  assert.equal(to.searchParams.get("redirect_uri"), `${ORIGIN}/callback`);
  const state = to.searchParams.get("state");
  assert.equal(cookieOf(res, "csrf-token"), `github_${state}`);

  const wrong = await run(env, `/callback?code=c&state=other`, { cookie: `csrf-token=github_${state}` });
  assert.ok((await wrong.text()).includes("CSRF_DETECTED"));
  const missing = await run(env, `/callback?state=${state}`, { cookie: `csrf-token=github_${state}` });
  assert.ok((await missing.text()).includes("AUTH_CODE_REQUEST_FAILED"));
});

test("/auth refuses other providers and methods; unknown paths are 404", async () => {
  const env = fakeEnv();
  assert.ok((await (await run(env, "/auth?provider=gitlab")).text()).includes("UNSUPPORTED_BACKEND"));
  assert.equal((await auth(new Request(`${ORIGIN}/auth`, { method: "POST" }), env, new URL(`${ORIGIN}/auth`))).status, 405);
  assert.equal((await run(env, "/auth/other")).status, 404);
});

test("/auth/setup/done refuses a code without the matching state cookie", async () => {
  const env = fakeEnv();
  const res = await run(env, "/auth/setup/done?code=abc&state=xyz", { cookie: "auth-setup-state=other" });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("expired or was not started from this page"));
  assert.equal(env.kv.has("auth:app"), false);
});

test("/auth/setup without a known repository explains what to set", async () => {
  const res = await run(fakeEnv({ repo: "OWNER/REPO" }), "/auth/setup");
  const body = await res.text();
  assert.ok(body.includes("does not know which repository"));
  assert.ok(!body.includes("settings/apps/new"));
});
