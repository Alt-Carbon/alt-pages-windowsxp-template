import { test } from "node:test";
import assert from "node:assert/strict";
import { HELLO_KEY, helloPayload, helloTarget, sayHello } from "../src/worker/hello.js";

const DASHBOARD = "https://alt-pages-dashboard.example.workers.dev";
const CONFIG = { dashboard: DASHBOARD, owner: "asha", repo: "asha/asha-site", template: "sidebar@0.1.0" };

test("helloTarget: the dashboard's /api/hello, or nothing", () => {
  assert.equal(helloTarget(DASHBOARD), `${DASHBOARD}/api/hello`);
  assert.equal(helloTarget(`${DASHBOARD}/`), `${DASHBOARD}/api/hello`);
  assert.equal(helloTarget(" https://example.com/dash/ "), "https://example.com/dash/api/hello");
  assert.equal(helloTarget(""), null);
  assert.equal(helloTarget(undefined), null);
  assert.equal(helloTarget("not an address"), null);
  assert.equal(helloTarget("ftp://example.com"), null);
});

test("helloPayload: host, origin, repository, owner and template; nothing locally or without a dashboard", () => {
  assert.deepEqual(helloPayload("https://asha-site.asha.workers.dev/about?x=1", CONFIG), {
    host: "asha-site.asha.workers.dev",
    origin: "https://asha-site.asha.workers.dev",
    repo: "asha/asha-site",
    owner: "asha",
    template: "sidebar@0.1.0",
  });
  assert.equal(helloPayload("https://asha.example.com/", { ...CONFIG, dashboard: "" }), null);
  assert.equal(helloPayload("https://asha.example.com/", null), null);
  for (const local of ["http://localhost:8787/", "http://127.0.0.1:8787/", "http://site.localhost/", "http://[::1]:8787/"]) assert.equal(helloPayload(local, CONFIG), null, local);
});

// A Worker environment with an in-memory KV and the built /hello/config.json.
const fakeEnv = (config = CONFIG) => {
  const kv = new Map();
  const puts = [];
  return {
    kv,
    puts,
    BOOKS: { get: async (k) => kv.get(k) ?? null, put: async (k, v, opts) => { kv.set(k, v); puts.push({ k, opts }); } },
    ASSETS: { fetch: async () => (config ? Response.json(config) : new Response("Not found", { status: 404 })) },
  };
};
const page = (url = "https://asha.example.com/") => new Request(url);

// Each call is a new hour, so the once-an-hour check per isolate never gets in the way.
let clock = Date.parse("2026-11-17T00:00:00Z");
const later = () => (clock += 2 * 60 * 60 * 1000);

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("sayHello posts once, then not again while hello:sent is in KV for a day", async () => {
  const env = fakeEnv();
  const calls = [];
  await withFetch(async (url, init) => (calls.push({ url, init }), new Response("ok")), async () => {
    assert.equal(await sayHello(page(), env, later()), "sent");
    assert.equal(await sayHello(page(), env, later()), "already sent");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DASHBOARD}/api/hello`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { host: "asha.example.com", origin: "https://asha.example.com", repo: "asha/asha-site", owner: "asha", template: "sidebar@0.1.0" });
  assert.deepEqual(env.puts, [{ k: HELLO_KEY, opts: { expirationTtl: 86400 } }]);
});

test("sayHello looks in KV at most once an hour per isolate", async () => {
  const env = fakeEnv();
  let gets = 0;
  const get = env.BOOKS.get;
  env.BOOKS.get = async (k) => (gets++, get(k));
  await withFetch(async () => new Response("ok"), async () => {
    const t = later();
    await sayHello(page(), env, t);
    assert.equal(await sayHello(page(), env, t + 60 * 1000), "checked recently");
  });
  assert.equal(gets, 1);
});

test("sayHello sends nothing with no dashboard, and never throws", async () => {
  const off = fakeEnv({ ...CONFIG, dashboard: "" });
  let called = false;
  await withFetch(async () => ((called = true), new Response("ok")), async () => {
    assert.equal(await sayHello(page(), off, later()), "off");
    assert.equal(await sayHello(page(), fakeEnv(null), later()), "off");
  });
  assert.equal(called, false);
  assert.equal(off.kv.has(HELLO_KEY), false);

  // The dashboard unreachable: no error, and another try in an hour rather than a day.
  const down = fakeEnv();
  await withFetch(async () => { throw new Error("network"); }, async () => {
    assert.equal(await sayHello(page(), down, later()), "failed");
  });
  assert.deepEqual(down.puts, [{ k: HELLO_KEY, opts: { expirationTtl: 3600 } }]);

  // KV itself failing.
  const broken = fakeEnv();
  broken.BOOKS.get = async () => { throw new Error("kv"); };
  assert.equal(await sayHello(page(), broken, later()), "error");
});
