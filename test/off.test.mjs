import { test } from "node:test";
import assert from "node:assert/strict";
import { notIfOff } from "../src/worker/off.js";

const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const env = (notFound) => ({ ASSETS: { fetch: async (u) => (String(u).endsWith("/404") && notFound ? html(notFound) : new Response("", { status: 404 })) } });
const req = new Request("https://asha.example.com/research");

test("a page switched off in the editor answers with the site's not-found page and a 404", async () => {
  const res = await notIfOff(req, env("<title>Page not found</title>"), html('<head><meta name="alt-pages-off" content=""></head>'));
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Page not found/);
});

test("the not-found page gets the same finishing as any page", async () => {
  const finish = async (_r, r) => new Response((await r.text()).replace("ORIGIN", "https://asha.example.com"), r);
  const res = await notIfOff(req, env("<a href=\"ORIGIN/\">Home</a>"), html('<meta name="alt-pages-off" content="">'), finish);
  assert.equal(await res.text(), '<a href="https://asha.example.com/">Home</a>');
});

test("without a not-found page it still says not found", async () => {
  const res = await notIfOff(req, env(null), html('<meta name="alt-pages-off" content="">'));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "Not found");
});

test("pages that are on, other files and errors pass through untouched", async () => {
  const on = await notIfOff(req, env("x"), html("<p>Research</p>"));
  assert.equal(on.status, 200);
  assert.equal(await on.text(), "<p>Research</p>");
  const css = new Response("a{}", { headers: { "content-type": "text/css" } });
  assert.equal(await notIfOff(req, env("x"), css), css);
  const missing = html("gone", 404);
  assert.equal(await notIfOff(req, env("x"), missing), missing);
});
