// Once a day the site tells the company dashboard where it lives, so the dashboard's list of sites
// stays right without anyone filling it in: the address visitors used, the GitHub repository, and
// which template (and version) it was built from. Nothing about visitors is sent.
//
// It is best effort and never in the way: it runs after the page has been answered
// (ctx.waitUntil), at most once an hour per isolate it looks in KV for `hello:sent`, and only
// when that key is missing does it POST. Any failure is swallowed.
//
// Where to send it comes from the build, not from wrangler vars: scripts/prepare.mjs writes
// /hello/config.json from Site settings → Advanced → Company dashboard (empty means never),
// with the repository, owner and template it already works out for the meta tags.

export const HELLO_KEY = "hello:sent";
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;
const CHECK_GAP = HOUR * 1000;
const UA = "alt-pages-site";

// The dashboard's hello address, or null when none is set or it is not a web address.
export function helloTarget(dashboard) {
  const s = String(dashboard || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}/api/hello`;
  } catch {
    return null;
  }
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

// What gets sent for a visit to `url`, or null when nothing should be: no dashboard, or the site
// is running on this computer (npm run preview).
export function helloPayload(url, config) {
  if (!config || !helloTarget(config.dashboard)) return null;
  const { hostname, host, origin } = new URL(url);
  if (LOCAL.test(hostname)) return null;
  return { host, origin, repo: config.repo || "", owner: config.owner || "", template: config.template || "" };
}

// When this isolate last looked in KV.
let checkedAt = 0;

// Says hello if a day has passed since the last one. Resolves to what it did, never rejects.
export async function sayHello(request, env, now = Date.now()) {
  if (now - checkedAt < CHECK_GAP) return "checked recently";
  checkedAt = now;
  try {
    if (await env.BOOKS.get(HELLO_KEY)) return "already sent";
    const res = await env.ASSETS.fetch(new URL("/hello/config.json", request.url));
    const config = res.ok ? await res.json() : null;
    const body = helloPayload(request.url, config);
    if (!body) return "off";
    // Any answer from the dashboard counts, even a refusal: ask again tomorrow. No answer, or a
    // server error, asks again in an hour.
    let answered = false;
    try {
      const sent = await fetch(helloTarget(config.dashboard), {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify(body),
      });
      answered = sent.status < 500;
    } catch {
      /* the dashboard is down or unreachable */
    }
    await env.BOOKS.put(HELLO_KEY, new Date(now).toISOString(), { expirationTtl: answered ? DAY : HOUR });
    return answered ? "sent" : "failed";
  } catch {
    return "error";
  }
}
