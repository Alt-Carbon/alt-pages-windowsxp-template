// Editor sign-in inside this site's own Worker, so nothing about signing in depends on the
// company. The editor (Sveltia CMS) needs a small server to swap a GitHub login code for a
// token; this is that server, and the credentials it uses belong to a GitHub App that the
// owner creates on their own account in one click, through GitHub's app manifest flow.
//
// GET  /auth/setup            a page with one button: "Create the sign-in app on GitHub"
// GET  /auth/setup/done       GitHub sends the owner back here with a code; the Worker turns it
//                             into the app's client id and secret and keeps them in KV
// GET  /auth/setup/installed  GitHub sends the owner back here after installing the app
// GET  /auth/status           { ready }: whether the editor can sign in yet. The editor's page
//                             asks this before loading, and shows its own "set up sign-in
//                             first" screen until it is true (see public/admin/index.html)
// GET  /auth?provider=github  the editor opens this in a popup; redirects to GitHub to sign in
// GET  /callback              GitHub sends the person back here; the token goes to the editor
//                             by postMessage, to this site's origin only
//
// This is the editor's sign-in by default: scripts/prepare.mjs points the editor's base_url at
// this site. Site settings → Advanced → "Other sign-in service" points it somewhere else instead.
//
// Only the owner of the site's repository can complete setup: GitHub tells us who owns the
// new app, and that login must match the repository owner in the editor's configuration.
// The app asks for contents: write and metadata: read on the repositories it is installed
// on, which is what the editor needs, and nothing else. The secret lives in this Worker's own
// KV namespace, in the owner's Cloudflare account.

const APP_KEY = "auth:app";
const STATE_COOKIE = "auth-setup-state";
const CSRF_COOKIE = "csrf-token";
const TEN_MINUTES = 600;
const UA = "alt-pages-site-auth";

const cookie = (header, name) => (header || "").split(/;\s*/).map((p) => p.split("=")).find(([k]) => k === name)?.[1] || "";
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const random = () => crypto.randomUUID().replaceAll("-", "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// --- the pure parts, also used by the tests ----------------------------------------------

// The GitHub App that setup creates. GitHub caps the name at 34 characters.
export function manifest(origin, repo) {
  const name = `${(repo || "").split("/")[1] || new URL(origin).hostname} sign-in`.slice(0, 34);
  return {
    name,
    url: origin,
    redirect_url: `${origin}/auth/setup/done`,
    callback_urls: [`${origin}/callback`],
    // After installing, GitHub sends the owner back to this site instead of leaving them on
    // GitHub's settings page with no way back.
    setup_url: `${origin}/auth/setup/installed`,
    setup_on_update: false,
    public: false,
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  };
}

// "owner/name" from the editor's generated config, or "" when the build could not tell.
export function repoFromConfig(yml) {
  const m = /^\s*repo:\s*(\S+)/m.exec(yml || "");
  const repo = m ? m[1].trim() : "";
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && repo !== "OWNER/REPO" ? repo : "";
}

export const sameLogin = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// The page the editor's popup ends on. Sveltia's protocol: the opener says "authorizing:github",
// this page answers "authorization:github:<success|error>:<json>". A token is only ever sent to
// this site's own origin; an error is harmless and goes to whoever asked.
// Sveltia's protocol: the window says "authorizing:github"; the editor answers with the same
// message; the window replies "authorization:github:<success|error>:<json>". A token is only ever
// sent to this site's own origin; an error is harmless and goes to whoever asked.
function popupScript(origin, { token, error, errorCode }) {
  const state = error ? "error" : "success";
  const content = error ? { provider: "github", error, errorCode } : { provider: "github", token };
  return `(() => {
  const own = ${JSON.stringify(origin)};
  const hasToken = ${JSON.stringify(!!token)};
  window.addEventListener("message", ({ data, origin }) => {
    if (data !== "authorizing:github") return;
    if (hasToken && origin !== own) return;
    window.opener?.postMessage(${JSON.stringify(`authorization:github:${state}:`)} + ${JSON.stringify(JSON.stringify(content))}, origin);
  });
  window.opener?.postMessage("authorizing:github", "*");
})();`;
}

// The page the editor's sign-in window ends on.
export function popupHtml(origin, content) {
  return `<!doctype html><html><body><script>
${popupScript(origin, content)}
</script></body></html>`;
}

export const SETUP_FIRST = "Sign-in isn't set up for this site yet. Reload this page and press Set up sign-in.";

// The editor's sign-in window when the site has no sign-in app yet: it answers the editor with an
// error right away (so the editor stops waiting) and offers the setup in a normal tab.
export function setupNeededHtml(origin) {
  return page("Set up sign-in first", `<h1>First, set up sign-in</h1>
<p>Your site signs you in to its editor by itself. The first time, it needs a small app on your GitHub account: two clicks.</p>
<a class="btn" href="/auth/setup" target="_blank" rel="opener">Set up sign-in</a>
<p class="muted">It opens in a new tab. When it says sign-in is ready, come back to your editor and press "Sign in with GitHub" again. You can close this window.</p>`).replace("</body>", `<script>${popupScript(origin, { error: SETUP_FIRST, errorCode: "SETUP_REQUIRED" })}</script></body>`);
}

// Where GitHub sends the owner after installing the app.
export function installedHtml(origin) {
  return page("Sign-in is ready", `<h1>Sign-in is ready</h1>
<p>Your site can now sign you in to its editor with GitHub. Go back to your editor's tab: it has noticed, and shows <b>Sign in with GitHub</b>. You can close this tab.</p>
<a class="btn" href="${esc(origin)}/admin/">Or open the editor here</a>`);
}

// Ready once the app exists and, for apps made since 17 Nov 2026, once GitHub has said it is
// installed. Older apps have no "installed" field and were set up by hand: they count as ready.
export const isReady = (app) => !!app && app.installed !== false;

// --- helpers -------------------------------------------------------------------------------

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });

const popup = (origin, content, extra = {}) =>
  html(popupHtml(origin, content), 200, { "set-cookie": setCookie(CSRF_COOKIE, "deleted", 0), ...extra });

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;padding:40px 20px;font:15px/1.55 system-ui,sans-serif;color:#1a1a1a;background:#fafaf8}main{max-width:34rem;margin:0 auto}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.6rem 0}code{font:.9em ui-monospace,monospace;background:#eee;padding:.1em .3em;border-radius:3px}button,a.btn{display:inline-block;margin-top:.6rem;padding:.55em 1em;border:0;border-radius:6px;background:#1a1a1a;color:#fff;font:inherit;cursor:pointer;text-decoration:none}.muted{color:#666}</style></head><body><main>${body}</main></body></html>`;

async function readApp(env) {
  try {
    return (await env.BOOKS.get(APP_KEY, "json")) || null;
  } catch {
    return null;
  }
}

// The site's repository, from the generated editor config.
async function siteRepo(env, request) {
  try {
    const res = await env.ASSETS.fetch(new URL("/admin/config.yml", request.url));
    return res.ok ? repoFromConfig(await res.text()) : "";
  } catch {
    return "";
  }
}

// --- setup -----------------------------------------------------------------------------------

async function setupPage(request, env, url, note = "") {
  const origin = url.origin;
  const repo = await siteRepo(env, request);
  const app = await readApp(env);
  const state = random();
  const form = repo
    ? `<form method="post" action="https://github.com/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest(origin, repo)))}">
<button type="submit">${app ? "Create a new sign-in app on GitHub" : "Create the sign-in app on GitHub"}</button></form>
<p class="muted">GitHub shows the app's name and asks you to confirm. You must be signed in to GitHub as <code>${esc(repo.split("/")[0])}</code>, the owner of <code>${esc(repo)}</code>. Afterwards GitHub asks where to install it: choose this site's repository only.</p>`
    : `<p>The site does not know which repository it is built from, so it cannot set up sign-in. Set Advanced → Repository in the editor (or <code>repo</code> in <code>content/site.json</code>) to <code>owner/name</code>, publish, and come back.</p>`;
  // Created but never installed (the tab was closed on GitHub's install page): finish that first.
  if (app && app.installed === false && !note) {
    const install = `https://github.com/apps/${app.slug}/installations/new`;
    return html(page("Install the sign-in app", `<h1>One step left: install the sign-in app</h1>
<p>The app <code>${esc(app.slug)}</code> is on your GitHub account. Install it on this site's repository${repo ? `, <code>${esc(repo)}</code>` : ""}, so the editor may read and write your content.</p>
<a class="btn" href="${install}">Install it</a>
<p class="muted">GitHub brings you back here afterwards.</p>`), 200, { "set-cookie": setCookie(STATE_COOKIE, state, TEN_MINUTES) });
  }
  const current = app ? `<p>Sign-in is set up: the GitHub App <a href="${esc(app.html_url || `https://github.com/apps/${app.slug}`)}">${esc(app.slug)}</a>, owned by <code>${esc(app.owner)}</code>. If sign-in has stopped working (for example the app was deleted on GitHub), create a new one; it replaces this one.</p>` : "";
  return html(page("Editor sign-in", `<h1>Editor sign-in for this site</h1>
<p>The editor at <code>/admin</code> signs in with GitHub. GitHub needs a small app registered for that; this creates one on your own GitHub account, in one step, and keeps its keys in this site's own storage. Nothing about signing in then depends on anyone else.</p>
${note ? `<p><b>${esc(note)}</b></p>` : ""}${current}${form}`), 200, { "set-cookie": setCookie(STATE_COOKIE, state, TEN_MINUTES) });
}

async function setupDone(request, env, url) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const expected = cookie(request.headers.get("cookie"), STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return setupPage(request, env, url, "That link has expired or was not started from this page. Try again.");

  const repo = await siteRepo(env, request);
  let app;
  try {
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": UA },
    });
    app = await res.json();
    if (!res.ok || !app.client_id || !app.client_secret) throw new Error(app.message || `GitHub answered ${res.status}`);
  } catch (e) {
    return setupPage(request, env, url, `GitHub did not hand over the app: ${e.message}`);
  }
  const owner = app.owner?.login || "";
  if (!sameLogin(owner, repo.split("/")[0])) {
    return setupPage(request, env, url, `The app was created by ${owner || "someone else"}, but this site's repository belongs to ${repo.split("/")[0] || "an unknown login"}. Delete that app on GitHub and try again signed in as the repository owner.`);
  }
  await env.BOOKS.put(APP_KEY, JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, slug: app.slug, owner, html_url: app.html_url, created: new Date().toISOString(), installed: false }));
  const install = `https://github.com/apps/${app.slug}/installations/new`;
  return html(page("Sign-in app created", `<h1>The sign-in app is ready</h1>
<p>GitHub created <a href="${esc(app.html_url || install)}">${esc(app.slug)}</a> on your account and this site now holds its keys.</p>
<p>One more step: install the app on this site's repository, <code>${esc(repo)}</code>, so the editor may read and write your content. Choose only that repository.</p>
<a class="btn" href="${install}">Install it on ${esc(repo)}</a>
<p class="muted">GitHub brings you back here afterwards, with a button to your editor.</p>`), 200, { "set-cookie": setCookie(STATE_COOKIE, "deleted", 0) });
}

// --- the editor's sign-in -----------------------------------------------------------------

async function start(request, env, url) {
  const origin = url.origin;
  const provider = url.searchParams.get("provider") || "github";
  if (provider !== "github") return popup(origin, { error: "This site signs in with GitHub only.", errorCode: "UNSUPPORTED_BACKEND" });
  const app = await readApp(env);
  // Not set up yet. The setup goes through several GitHub pages, which this small sign-in window
  // cannot survive: the editor would wait for it forever. So the window tells the editor at once
  // ("set up sign-in first"), and offers the setup in a normal tab.
  if (!app) return html(setupNeededHtml(origin), 200, { "set-cookie": setCookie(CSRF_COOKIE, "deleted", 0) });
  const csrf = random();
  const params = new URLSearchParams({ client_id: app.client_id, redirect_uri: `${origin}/callback`, state: csrf });
  return new Response(null, {
    status: 302,
    headers: { location: `https://github.com/login/oauth/authorize?${params}`, "set-cookie": setCookie(CSRF_COOKIE, `github_${csrf}`, TEN_MINUTES), "cache-control": "no-store" },
  });
}

async function callback(request, env, url) {
  const origin = url.origin;
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const [, csrf] = /^github_(\w+)$/.exec(cookie(request.headers.get("cookie"), CSRF_COOKIE)) || [];
  if (!code || !state) return popup(origin, { error: "GitHub did not send a login code. Try again.", errorCode: "AUTH_CODE_REQUEST_FAILED" });
  if (!csrf || state !== csrf) return popup(origin, { error: "The sign-in did not start from this site, or took too long. Try again.", errorCode: "CSRF_DETECTED" });
  const app = await readApp(env);
  if (!app) return popup(origin, { error: "This site has no sign-in app. Open /auth/setup.", errorCode: "MISCONFIGURED_CLIENT" });
  let token = "", error = "";
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: `${origin}/callback` }),
    });
    const data = await res.json();
    token = data.access_token || "";
    error = data.error_description || data.error || "";
  } catch {
    return popup(origin, { error: "Could not reach GitHub for a token. Try again later.", errorCode: "TOKEN_REQUEST_FAILED" });
  }
  if (!token) return popup(origin, { error: error || "GitHub gave no token.", errorCode: "TOKEN_REQUEST_FAILED" });
  return popup(origin, { token });
}

// GitHub adds installation_id and setup_action=install. Anyone could open this address, but all
// it changes is whether the editor shows "set up sign-in first"; signing in still needs GitHub.
async function installed(env, url) {
  const app = await readApp(env);
  if (app && app.installed === false && url.searchParams.get("installation_id")) {
    await env.BOOKS.put(APP_KEY, JSON.stringify({ ...app, installed: true, installed_at: new Date().toISOString() }));
  }
  return html(installedHtml(url.origin));
}

async function status(env) {
  const app = await readApp(env);
  return new Response(JSON.stringify({ ready: isReady(app), created: !!app }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function auth(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/auth") return start(request, env, url);
  if (path === "/callback") return callback(request, env, url);
  if (path === "/auth/setup") return setupPage(request, env, url);
  if (path === "/auth/setup/done") return setupDone(request, env, url);
  if (path === "/auth/setup/installed") return installed(env, url);
  if (path === "/auth/status") return status(env);
  return new Response("Not found", { status: 404 });
}
