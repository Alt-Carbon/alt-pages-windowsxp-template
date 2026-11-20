import { test } from "node:test";
import assert from "node:assert/strict";
import { auth, manifest, popupHtml, repoFromConfig, sameLogin, SETUP_FIRST } from "../src/worker/auth.js";

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

test("/auth with no app yet answers the editor at once and offers the setup in a new tab", async () => {
  const res = await run(fakeEnv(), "/auth?provider=github&site_id=asha.example.workers.dev&scope=repo");
  assert.equal(res.status, 200);
  const body = await res.text();
  // The editor gets an error straight away instead of waiting on a window that wanders off to GitHub.
  assert.ok(body.includes("authorization:github:error:"));
  assert.ok(body.includes(JSON.stringify(JSON.stringify({ provider: "github", error: SETUP_FIRST, errorCode: "SETUP_REQUIRED" }))));
  assert.ok(body.includes('href="/auth/setup" target="_blank"'));
  assert.equal(cookieOf(res, "auth-setup-state"), undefined, "no setup is started inside the editor's window");
});

test("/auth/status tells the editor's page whether sign-in is ready, and installing makes it so", async () => {
  const status = async (env) => { const r = await run(env, "/auth/status"); assert.equal(r.headers.get("cache-control"), "no-store"); return r.json(); };
  assert.deepEqual(await status(fakeEnv()), { ready: false, created: false });
  const env = fakeEnv({ app: { client_id: "c", client_secret: "s", slug: "asha-site-sign-in", owner: "asha", installed: false } });
  assert.deepEqual(await status(env), { ready: false, created: true }, "created but not installed yet");
  await run(env, "/auth/setup/installed");
  assert.deepEqual(await status(env), { ready: false, created: true }, "only GitHub's return, with an installation id, counts");
  await run(env, "/auth/setup/installed?installation_id=7&setup_action=install");
  assert.deepEqual(await status(env), { ready: true, created: true });
  assert.ok(JSON.parse(env.kv.get("auth:app")).installed_at);
  // Apps set up before the installed flag existed keep working.
  assert.deepEqual(await status(fakeEnv({ app: { client_id: "c", client_secret: "s" } })), { ready: true, created: true });
  // Installing again (or any later visit) leaves a ready app alone.
  const ready = fakeEnv({ app: { client_id: "c", installed: true, installed_at: "then" } });
  await run(ready, "/auth/setup/installed?installation_id=7");
  assert.equal(JSON.parse(ready.kv.get("auth:app")).installed_at, "then");
});

test("/auth/setup shows the manifest form with a state cookie", async () => {
  const res = await run(fakeEnv(), "/auth/setup");
  assert.equal(res.status, 200);
  const body = await res.text();
  const state = cookieOf(res, "auth-setup-state");
  assert.ok(state && state.length >= 32);
  assert.ok(body.includes(`action="https://github.com/settings/apps/new?state=${state}"`));
  assert.ok(body.includes('name="manifest"'));
  assert.ok(body.includes("asha-site sign-in"));
  assert.ok(body.includes("Step 1 of 2"));
  assert.ok(body.includes("Create GitHub App for asha"), "shows the button GitHub will show");
});

test("after installing, GitHub comes back to /auth/setup/installed, which leads to the editor", async () => {
  assert.equal(manifest(ORIGIN, "asha/asha-site").setup_url, `${ORIGIN}/auth/setup/installed`);
  const res = await run(fakeEnv(), "/auth/setup/installed?installation_id=1&setup_action=install");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("Sign-in is ready"));
  assert.ok(body.includes(`href="${ORIGIN}/admin/"`));
  assert.ok(body.includes("Go back to your editor"));
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
  assert.ok(body.includes("doesn't know its repository"));
  assert.ok(!body.includes("settings/apps/new"));
});

test("/auth/setup/done keeps the new app's keys, marked not installed until GitHub says so", async () => {
  const env = fakeEnv();
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /app-manifests\/abc\/conversions$/);
    return new Response(JSON.stringify({ client_id: "Iv1.x", client_secret: "sec", slug: "asha-site-sign-in", owner: { login: "Asha" }, html_url: "https://github.com/apps/asha-site-sign-in" }), { status: 201 });
  };
  try {
    const res = await run(env, "/auth/setup/done?code=abc&state=s1", { cookie: "auth-setup-state=s1" });
    const body = await res.text();
    assert.ok(body.includes("https://github.com/apps/asha-site-sign-in/installations/new"));
    assert.ok(body.includes("Step 2 of 2"));
    const app = JSON.parse(env.kv.get("auth:app"));
    assert.equal(app.client_id, "Iv1.x");
    assert.equal(app.installed, false);
    assert.equal(app.home, ORIGIN, "the address GitHub will send people back to");
    assert.deepEqual(await (await run(env, "/auth/status")).json(), { ready: false, created: true, home: ORIGIN });
  } finally {
    globalThis.fetch = saved;
  }
});

test("/auth/setup after creating but not installing goes straight to the install step", async () => {
  const res = await run(fakeEnv({ app: { client_id: "c", slug: "asha-site-sign-in", owner: "asha", installed: false } }), "/auth/setup");
  const body = await res.text();
  assert.ok(body.includes("Install the sign-in app"));
  assert.ok(body.includes("Step 2 of 2"));
  assert.ok(body.includes('href="https://github.com/apps/asha-site-sign-in/installations/new"'));
  assert.ok(!body.includes("settings/apps/new"));
});

// The same site on its own domain: GitHub only knows the app's home address.
const DOMAIN = "https://asharao.com";
const at = (origin, env, path, headers = {}) => auth(new Request(`${origin}${path}`, { headers }), env, new URL(`${origin}${path}`));
const withGitHub = async (token, fn) => {
  const saved = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => { asked.push([String(url), JSON.parse(init.body)]); return new Response(JSON.stringify(token ? { access_token: token } : { error: "bad_verification_code" })); };
  try { return await fn(asked); } finally { globalThis.fetch = saved; }
};

test("on its own domain, the editor signs in at the app's home address and gets its token back there", async () => {
  const env = fakeEnv({ app: { client_id: "Iv1.abc", client_secret: "s3cret", slug: "asha-site-sign-in", owner: "asha", home: ORIGIN } });
  // 1. The domain sends the window home, with its address signed.
  const first = await at(DOMAIN, env, "/auth?provider=github");
  assert.equal(first.status, 302);
  const home = new URL(first.headers.get("location"));
  assert.equal(home.origin + home.pathname, `${ORIGIN}/auth`);
  assert.equal(home.searchParams.get("for"), DOMAIN);
  // 2. Home checks the signature and goes to GitHub with its own callback, remembering the domain.
  const second = await at(ORIGIN, env, `/auth?${home.searchParams}`);
  const gh = new URL(second.headers.get("location"));
  assert.equal(gh.searchParams.get("redirect_uri"), `${ORIGIN}/callback`);
  const state = gh.searchParams.get("state");
  const csrf = cookieOf(second, "csrf-token");
  assert.match(csrf, new RegExp(`^github_${state}\\.`));
  // 3. GitHub comes back home; the token goes to the domain's editor, and to nobody else.
  await withGitHub("gho_tok", async (asked) => {
    const done = await (await at(ORIGIN, env, `/callback?code=c&state=${state}`, { cookie: `csrf-token=${csrf}` })).text();
    assert.ok(done.includes(JSON.stringify(DOMAIN)), "posted to the domain");
    assert.ok(done.includes("gho_tok"));
    assert.equal(asked[0][1].redirect_uri, `${ORIGIN}/callback`);
  });
  // A made-up address, or one with someone else's signature, gets nothing.
  for (const q of [`for=${encodeURIComponent("https://evil.example")}&sig=x`, `for=${encodeURIComponent("javascript:alert(1)")}&sig=x`]) {
    const res = await at(ORIGIN, env, `/auth?provider=github&${q}`);
    assert.ok((await res.text()).includes("CSRF_DETECTED"));
  }
  assert.deepEqual(await (await at(DOMAIN, env, "/auth/status")).json(), { ready: true, created: true, home: ORIGIN }, "the editor learns where sign-in happens");
  // Asking for its own address is just a normal sign-in.
  const plain = await at(ORIGIN, env, `/auth?provider=github&for=${encodeURIComponent(ORIGIN)}`);
  assert.match(cookieOf(plain, "csrf-token"), /^github_\w+$/);
  // A cookie whose address can't be read: the answer stays at home.
  await withGitHub("gho_tok", async () => {
    const odd = await (await at(ORIGIN, env, "/callback?code=c&state=zz", { cookie: "csrf-token=github_zz.%%%" })).text();
    assert.ok(odd.includes(JSON.stringify(ORIGIN)));
  });
});

test("an app set up before its home address was kept learns it from its first sign-in", async () => {
  const env = fakeEnv({ app: { client_id: "Iv1.abc", client_secret: "s", slug: "asha-site-sign-in", owner: "asha" } });
  const res = await run(env, "/auth?provider=github");
  const state = new URL(res.headers.get("location")).searchParams.get("state");
  await withGitHub("gho_tok", async () => {
    await run(env, `/callback?code=c&state=${state}`, { cookie: `csrf-token=github_${state}` });
  });
  assert.equal(JSON.parse(env.kv.get("auth:app")).home, ORIGIN);
  // A failed sign-in teaches it nothing.
  const env2 = fakeEnv({ app: { client_id: "Iv1.abc", client_secret: "s", slug: "x", owner: "asha" } });
  await withGitHub("", async () => {
    const t = await (await run(env2, "/callback?code=c&state=q", { cookie: "csrf-token=github_q" })).text();
    assert.ok(t.includes("TOKEN_REQUEST_FAILED"));
  });
  assert.equal(JSON.parse(env2.kv.get("auth:app")).home, undefined);
});
