// Editor sign-in inside this site's own Worker, so nothing about signing in depends on the
// company. The editor (Sveltia CMS) needs a small server to swap a GitHub login code for a
// token; this is that server, and the credentials it uses belong to a GitHub App that the
// owner creates on their own account in one click, through GitHub's app manifest flow.
//
// GET  /auth/setup            a page with one button: "Create the sign-in app on GitHub"
// GET  /auth/setup/done       GitHub sends the owner back here with a code; the Worker turns it
//                             into the app's client id and secret and keeps them in KV
// GET  /auth/setup/installed  GitHub sends the owner back here after installing the app
// GET/POST /auth/update      the weekly update's last run, and "Update now" (src/worker/updates.js)
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
    setTimeout(() => window.close(), 400);
  });
  window.opener?.postMessage("authorizing:github", "*");
})();`;
}

// The page the editor's sign-in window ends on. It closes itself once the editor has the answer;
// if it can't (no editor waiting for it), it says where to go.
export function popupHtml(origin, content) {
  return page("Signing you in", `<h1>Signing you in…</h1>
<p>This window closes by itself. If it stays open, close it and go back to your editor's tab.</p>
<a class="btn quiet" href="${esc(origin)}/admin/">Open the editor</a>`).replace("</body>", `<script>
${popupScript(origin, content)}
</script></body>`);
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
  return page("Sign-in is ready", `${steps(3)}<div class="ok" aria-hidden="true">✓</div><h1>Sign-in is ready</h1>
<p>Go back to your editor's tab: it has noticed, and shows <b>Sign in with GitHub</b>. Press it, then <b>Authorize</b> on GitHub. You can close this tab.</p>
<a class="btn quiet" href="${esc(origin)}/admin/">Or open the editor here</a>`);
}

// Ready once the app exists and, for apps made since 17 Nov 2026, once GitHub has said it is
// installed. Older apps have no "installed" field and were set up by hand: they count as ready.
export const isReady = (app) => !!app && app.installed !== false;

// --- helpers -------------------------------------------------------------------------------

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });

const popup = (origin, content, extra = {}) =>
  html(popupHtml(origin, content), 200, { "set-cookie": setCookie(CSRF_COOKIE, "deleted", 0), ...extra });

// The setup pages share the editor's look (public/admin/index.html): Geist, Monsoon Iris, a
// centred column, light or dark with the system.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap">
<style>
:root{--bg:#f4f4f5;--card:#fff;--fg:#09090b;--muted:#71717a;--line:#e4e4e7;--accent:#3919A2;--accent-hover:#2d1482;--gh:#0d1117;--gh-fg:#e6edf3;--gh-line:#30363d;--gh-green:#238636}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--accent:#704BD7;--accent-hover:#8466dd}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:32px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 "Geist",system-ui,sans-serif}
main{width:100%;max-width:30rem}.logo{display:block;width:36px;height:36px;margin:0 0 20px}
.steps{display:flex;gap:6px;margin:0 0 14px}.steps span{flex:1;height:4px;border-radius:2px;background:var(--line)}.steps .on{background:var(--accent)}.steps .done{background:#16a34a}
.eyebrow{margin:0 0 4px;font-size:13px;font-weight:600;color:var(--muted)}h1{font-size:22px;line-height:1.25;letter-spacing:-.01em;margin:0 0 10px;text-wrap:balance}
p{margin:0 0 12px;color:var(--muted);text-wrap:pretty}p b,li b{color:var(--fg);font-weight:600}code{font:.88em ui-monospace,monospace;background:var(--line);padding:.1em .35em;border-radius:4px;color:var(--fg)}
ol{margin:0 0 16px;padding-left:20px;color:var(--muted)}li{margin:4px 0}
button,a.btn{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;height:44px;margin:18px 0 10px;padding:0 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 15px/1 inherit;font-family:inherit;cursor:pointer;text-decoration:none}
button:hover,a.btn:hover{background:var(--accent-hover)}button:focus-visible,a.btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
a.btn.quiet{background:transparent;color:var(--fg);border:1px solid var(--line)}a{color:inherit}
.muted{font-size:13px}.next{margin:2px 0 8px;font-size:13px}
.gh{margin:0 0 16px;border-radius:10px;overflow:hidden;background:var(--gh);color:var(--gh-fg);font-size:12.5px;border:1px solid var(--gh-line);user-select:none;pointer-events:none}
.gh .bar{display:flex;align-items:center;gap:5px;height:24px;padding:0 10px;background:#161b22;border-bottom:1px solid var(--gh-line);color:#8b949e;font-size:11px}.gh .bar i{width:7px;height:7px;border-radius:50%;background:#30363d}.gh .bar span{margin-left:6px}
.gh .body{display:grid;justify-items:start;gap:10px;padding:14px 16px 18px}.gh .t{color:#8b949e}
.gh .press{position:relative;display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:6px;background:var(--gh-green);color:#fff;font-weight:600}.gh .press svg{position:absolute;right:-12px;bottom:-14px;width:18px;height:18px}
.gh .radio{display:flex;align-items:center;gap:8px}.gh .radio i{width:12px;height:12px;border-radius:50%;border:3.5px solid #2f81f7}
details{margin-top:18px;font-size:13px;color:var(--muted)}summary{cursor:pointer;font-weight:500}details p{margin-top:8px;font-size:13px}
.ok{display:grid;place-items:center;width:44px;height:44px;margin:0 0 18px;border-radius:50%;background:#16a34a;color:#fff;font-size:22px}
</style></head><body><main>${body}</main></body></html>`;
// Two bars: create, then install. n is the step being done; 3 means both are done.
const steps = (n) => `<div class="steps" aria-hidden="true">${[1, 2].map((i) => `<span class="${i < n ? "done" : i === n ? "on" : ""}"></span>`).join("")}</div>`;
// What GitHub will show next: a small picture of its page with the button to press, under our own
// button and drawn as a GitHub window (not a button) so nobody tries to press it here.
const POINTER = '<svg viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5 4 7.5-3 1.5-4-7.5L4 21z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ghPicture = (title, button, radio = "") => `<p class="next">Then, on GitHub:</p><div class="gh" aria-hidden="true"><div class="bar"><i></i><i></i><i></i><span>github.com</span></div><div class="body"><span class="t">${title}</span>${radio ? `<div class="radio"><i></i>${radio}</div>` : ""}<span class="press">${button}${POINTER}</span></div></div>`;

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
  const owner = repo.split("/")[0];
  // Created but never installed (the tab was closed on GitHub's install page): finish that first.
  if (app && app.installed === false && !note) {
    const install = `https://github.com/apps/${app.slug}/installations/new`;
    return html(page("Install the sign-in app", `${steps(2)}<p class="eyebrow">Step 2 of 2</p><h1>Install the sign-in app</h1>
<p>The app <b>${esc(app.slug)}</b> is on your GitHub account. Install it so your editor can save your changes${repo ? ` to <code>${esc(repo)}</code>` : ""}.</p>
<a class="btn" href="${install}">Continue to GitHub</a>
${ghPicture(`Install ${esc(app.slug)}`, "Install", "All repositories")}
<p class="muted">GitHub brings you back here afterwards.</p>`), 200, { "set-cookie": setCookie(STATE_COOKIE, state, TEN_MINUTES) });
  }
  if (!repo) {
    return html(page("Editor sign-in", `<h1>This site doesn't know its repository</h1>
<p>So it can't set up sign-in yet. In your editor, open <b>Site settings → Advanced</b>, put <code>owner/name</code> in <b>Repository</b>, publish, and come back. (Or set <code>repo</code> in <code>content/site.json</code>.)</p>`));
  }
  const form = `<form method="post" action="https://github.com/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest(origin, repo)))}">
<button type="submit">${app ? "Make a new sign-in app on GitHub" : "Continue to GitHub"}</button></form>`;
  const intro = app
    ? `<h1>Sign-in is already set up</h1>
<p>This site signs in with the GitHub app <a href="${esc(app.html_url || `https://github.com/apps/${app.slug}`)}">${esc(app.slug)}</a>, owned by <b>${esc(app.owner)}</b>. Only make a new one if signing in has stopped working, for example because the app was deleted on GitHub. The new one replaces it.</p>`
    : `${steps(1)}<p class="eyebrow">Step 1 of 2</p><h1>Set up sign-in for your editor</h1>
<p>Your site needs a small app on your GitHub to sign you in. GitHub makes it for you in one press.</p>`;
  return html(page("Editor sign-in", `${intro}
${note ? `<p><b>${esc(note)}</b></p>` : ""}${form}
${app ? "" : ghPicture("Create GitHub App", `Create GitHub App for ${esc(owner)}`)}
<p class="muted">Sign in to GitHub as <b>${esc(owner)}</b> first: the app must belong to whoever owns <code>${esc(repo)}</code>.</p>
<details><summary>What is this app?</summary><p>A private GitHub app that only you can use. It may read and change files in the repository you install it on, which is what your editor does when you press Publish. Its keys are kept in your site's own storage on your Cloudflare account; nothing about signing in depends on Alt Carbon.</p></details>`), 200, { "set-cookie": setCookie(STATE_COOKIE, state, TEN_MINUTES) });
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
  // id and pem (the app's private key) let the site's Worker act as the app for the weekly update
  // (src/worker/update.js). They stay in this site's own storage, like the client secret.
  await env.BOOKS.put(APP_KEY, JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, slug: app.slug, owner, html_url: app.html_url, app_id: app.id, pem: app.pem, created: new Date().toISOString(), installed: false }));
  const install = `https://github.com/apps/${app.slug}/installations/new`;
  return html(page("Install the sign-in app", `${steps(2)}<p class="eyebrow">Step 2 of 2</p><h1>Now install it</h1>
<p>GitHub made <b>${esc(app.slug)}</b>. One more press: install it so your editor can save your changes to <code>${esc(repo)}</code>.</p>
<a class="btn" href="${install}">Continue to GitHub</a>
${ghPicture(`Install ${esc(app.slug)}`, "Install", "All repositories")}
<p class="muted">All repositories is fine: the app is yours alone. To be strict, choose <b>Only select repositories</b> and pick <code>${esc(repo)}</code>. GitHub brings you back afterwards.</p>`), 200, { "set-cookie": setCookie(STATE_COOKIE, "deleted", 0) });
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

export { readApp };

export async function auth(request, env, url) {
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/auth/update") return (await import("./updates.js")).updateRoute(request, env);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  if (path === "/auth") return start(request, env, url);
  if (path === "/callback") return callback(request, env, url);
  if (path === "/auth/setup") return setupPage(request, env, url);
  if (path === "/auth/setup/done") return setupDone(request, env, url);
  if (path === "/auth/setup/installed") return installed(env, url);
  if (path === "/auth/status") return status(env);
  return new Response("Not found", { status: 404 });
}
