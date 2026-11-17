import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { gzipSync } from "node:zlib";
import { appJwt, installationToken, pemToPkcs8, pkcs1ToPkcs8 } from "../src/worker/github-app.js";
import { blobSha, runUpdate, untar } from "../src/worker/update.js";
import { LAST_KEY, updateRoute, weekly } from "../src/worker/updates.js";

const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const gitSha = (bytes) => sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)]));

// A .tar.gz like GitHub's: a global PAX header, everything inside "owner-repo-sha/".
function tarball(files, root = "Alt-Carbon-tpl-abc1234") {
  const blocks = [];
  const header = (name, size, type = "0", mode = "644") => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(mode.padStart(7, "0") + "\0", 100);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(type, 156);
    h.write("ustar\0", 257);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const g = Buffer.from("52 comment=abc1234\n");
  blocks.push(header("pax_global_header", g.length, "g"), pad(g));
  blocks.push(header(`${root}/`, 0, "5"));
  for (const [path, { bytes, mode = "644" }] of Object.entries(files)) {
    const full = `${root}/${path}`;
    if (full.length > 100) {
      const rec = ` path=${full}\n`;
      let len = rec.length + 2;
      while (String(len).length + rec.length !== len) len = String(len).length + rec.length;
      const body = Buffer.from(`${len}${rec}`);
      blocks.push(header("PaxHeader", body.length, "x"), pad(body));
    }
    blocks.push(header(full, bytes.length, "0", mode), pad(Buffer.from(bytes)));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// A pretend GitHub with two repositories (the site and the template) and the calls update.js makes.
function fakeGitHub({ site, template, siteMode = {}, tplMode = {} }) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = {};
  const putBlob = (bytes) => { const s = gitSha(bytes); blobs.set(s, Buffer.from(bytes)); return s; };
  const putTree = (map) => { const s = sha1(JSON.stringify(map)); trees.set(s, map); return s; };
  const putCommit = (tree, parents, message) => { const s = sha1(tree + parents.join() + message + commits.size); commits.set(s, { tree, parents, message }); return s; };
  const repoOf = (files, modes) => putCommit(putTree(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, { sha: putBlob(Buffer.from(t)), mode: modes[p] || "100644" }]))), [], "init");
  refs.site = repoOf(site, siteMode);
  refs.tpl = repoOf(template, tplMode);
  const archive = tarball(Object.fromEntries(Object.entries(template).map(([p, t]) => [p, { bytes: Buffer.from(t), mode: tplMode[p] === "100755" ? "755" : "644" }])));
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    const which = (r) => (r === "priya/site" ? "site" : r === "Alt-Carbon/tpl" ? "tpl" : null);
    if ((m = /^\/repos\/([\w.-]+\/[\w.-]+)\/git\/ref\/heads\/main$/.exec(path)) && which(m[1])) return json(200, { object: { sha: refs[which(m[1])] } });
    if ((m = /^\/repos\/[\w.-]+\/[\w.-]+\/git\/commits\/(\w+)$/.exec(path)) && method === "GET") return json(200, { sha: m[1], tree: { sha: commits.get(m[1]).tree } });
    if ((m = /^\/repos\/[\w.-]+\/[\w.-]+\/git\/trees\/(\w+)$/.exec(path))) return json(200, { truncated: false, tree: Object.entries(trees.get(m[1])).map(([p, e]) => ({ path: p, type: "blob", sha: e.sha, mode: e.mode })).concat([{ path: "content", type: "tree", sha: "t" }]) });
    if ((m = /^\/repos\/priya\/site\/git\/blobs\/(\w+)$/.exec(path))) return json(200, { content: blobs.get(m[1]).toString("base64"), encoding: "base64" });
    if (path === "/repos/Alt-Carbon/tpl/tarball/" + refs.tpl) return new Response(archive);
    if (path === "/repos/priya/site/git/blobs" && method === "POST") return json(201, { sha: putBlob(Buffer.from(body.content, "base64")) });
    if (path === "/repos/priya/site/git/trees" && method === "POST") {
      const map = { ...trees.get(body.base_tree) };
      for (const e of body.tree) if (e.sha === null) delete map[e.path]; else map[e.path] = { sha: e.sha || putBlob(Buffer.from(e.content)), mode: e.mode };
      return json(201, { sha: putTree(map) });
    }
    if (path === "/repos/priya/site/git/commits" && method === "POST") return json(201, { sha: putCommit(body.tree, body.parents, body.message) });
    if (path === "/repos/priya/site/git/refs/heads/main" && method === "PATCH") { refs.site = body.sha; return json(200, {}); }
    return json(404, { message: `No route ${method} ${path}` });
  };
  const files = () => Object.fromEntries(Object.entries(trees.get(commits.get(refs.site).tree)).map(([p, e]) => [p, blobs.get(e.sha).toString("latin1")]));
  return { fetch, calls, files, refs, commits, modeOf: (p) => trees.get(commits.get(refs.site).tree)[p]?.mode };
}

const WRANGLER_T = '{\n  // The template\n  "name": "my-site",\n  "main": "src/worker/index.js",\n  "kv_namespaces": [{ "binding": "BOOKS" }],\n  "triggers": { "crons": ["0 */12 * * *"] }\n}\n';
const WRANGLER_S = '{\n  // The template\n  "name": "priya-sharma",\n  "main": "src/worker/old.js",\n  "kv_namespaces": [{ "binding": "BOOKS", "id": "abc123" }]\n}\n';
const SITE = {
  "content/site.json": '{ "name": "Priya" }',
  "public/media/me.jpg": "PHOTO",
  ".github/notes.md": "mine",
  "src/pages/index.astro": "old page",
  "src/old.js": "gone soon",
  "wrangler.jsonc": WRANGLER_S,
  "package.json": '{\n  "name": "priya-sharma",\n  "version": "0.1.0"\n}\n',
  "README.md": "same",
};
const TEMPLATE = {
  "content/site.json": '{ "name": "Asha Rao" }',
  "public/media/sample.jpg": "SAMPLE",
  "src/pages/index.astro": "new page",
  "src/new.js": "brand new",
  [`src/${"deep/".repeat(20)}long-name.js`]: "a long path",
  "public/font.woff2": "\u0000\u0001binaryÿ",
  "scripts/run.sh": "#!/bin/sh\n",
  "wrangler.jsonc": WRANGLER_T,
  "package.json": '{\n  "name": "alt-pages-minimal-template",\n  "version": "0.2.0"\n}\n',
  "README.md": "same",
};
const opts = (gh) => ({ token: "t", repo: "priya/site", templateRepo: "Alt-Carbon/tpl", fetch: gh.fetch });

test("an update is one commit: the template's files, the site's words and settings kept", async () => {
  const gh = fakeGitHub({ site: SITE, template: TEMPLATE, tplMode: { "scripts/run.sh": "100755" } });
  const before = gh.refs.site;
  const r = await runUpdate(opts(gh));
  assert.equal(r.changed, true);
  assert.deepEqual(gh.commits.get(gh.refs.site).parents, [before], "one commit on top of the site");
  assert.match(gh.commits.get(gh.refs.site).message, /Update from the template \(Alt-Carbon\/tpl@\w{7}\)/);
  const after = gh.files();
  assert.equal(after["content/site.json"], SITE["content/site.json"], "the person's words untouched");
  assert.equal(after["public/media/me.jpg"], "PHOTO");
  assert.equal("public/media/sample.jpg" in after, false, "the template's media isn't copied");
  assert.equal(after[".github/notes.md"], "mine");
  assert.equal(after["src/pages/index.astro"], "new page");
  assert.equal(after["src/new.js"], "brand new");
  assert.equal(after[`src/${"deep/".repeat(20)}long-name.js`], "a long path", "long names come through");
  assert.equal(Buffer.from(after["public/font.woff2"], "latin1").equals(Buffer.from(TEMPLATE["public/font.woff2"], "utf8")), true, "binary files byte for byte");
  assert.equal(gh.modeOf("scripts/run.sh"), "100755");
  assert.equal("src/old.js" in after, false, "files the template dropped go");
  assert.match(after["wrangler.jsonc"], /"name": "priya-sharma"/);
  assert.match(after["wrangler.jsonc"], /"id": "abc123"/);
  assert.match(after["wrangler.jsonc"], /"main": "src\/worker\/index.js"/);
  assert.match(after["wrangler.jsonc"], /\/\/ The template/, "comments kept");
  assert.equal(JSON.parse(after["package.json"]).name, "priya-sharma");
  assert.equal(JSON.parse(after["package.json"]).version, "0.2.0");
  assert.deepEqual(r.removed, ["src/old.js"]);
  assert.ok(!r.files.includes("README.md"));
  assert.ok(gh.calls.filter((c) => c === "POST /repos/priya/site/git/blobs").length === 1, "only the binary file needs its own upload");
  // Again: nothing to do, no new commit.
  const head = gh.refs.site;
  assert.deepEqual(await runUpdate(opts(gh)), { changed: false, reason: "Already up to date.", template: gh.refs.tpl });
  assert.equal(gh.refs.site, head);
});

test("no update when it's turned off, or the site doesn't know where it's from", async () => {
  const off = fakeGitHub({ site: { ...SITE, "content/site.json": '{ "advanced": { "autoUpdate": false } }' }, template: TEMPLATE });
  assert.deepEqual(await runUpdate(opts(off)), { changed: false, reason: "Updates are turned off in Site settings." });
  assert.equal((await runUpdate({ ...opts(off), repo: "" })).reason, "The site doesn't know its repository.");
  assert.equal((await runUpdate({ ...opts(off), templateRepo: "nope" })).reason, "The site doesn't know which template it came from.");
  // An unreadable site.json doesn't stop it; a site without one either.
  const broken = fakeGitHub({ site: { ...SITE, "content/site.json": "{ nope" }, template: TEMPLATE });
  assert.equal((await runUpdate(opts(broken))).changed, true);
  const { ["content/site.json"]: _, ...noSettings } = SITE;
  assert.equal((await runUpdate(opts(fakeGitHub({ site: noSettings, template: TEMPLATE })))).changed, true);
  // A merge file the site doesn't have yet is simply added.
  const { ["package.json"]: __, ...noPkg } = SITE;
  const gh = fakeGitHub({ site: noPkg, template: TEMPLATE });
  await runUpdate(opts(gh));
  assert.equal(JSON.parse(gh.files()["package.json"]).name, "alt-pages-minimal-template");
});

test("GitHub's refusals become errors that say what was refused", async () => {
  const gh = fakeGitHub({ site: SITE, template: TEMPLATE });
  await assert.rejects(runUpdate({ ...opts(gh), repo: "someone/else" }), /GitHub answered 404 for GET \/repos\/someone\/else\/git\/ref\/heads\/main: No route/);
  const noArchive = { fetch: async (u, i) => (String(u).includes("/tarball/") ? new Response("", { status: 502 }) : gh.fetch(u, i)) };
  await assert.rejects(runUpdate({ ...opts(gh), fetch: noArchive.fetch }), /502 for the template's archive/);
  const truncated = { fetch: async (u, i) => { const r = await gh.fetch(u, i); if (/\/repos\/priya\/site\/git\/trees\//.test(String(u)) && (i?.method || "GET") === "GET") { const d = await r.json(); return new Response(JSON.stringify({ ...d, truncated: true })); } return r; } };
  assert.equal((await runUpdate({ ...opts(gh), fetch: truncated.fetch })).reason, "The repository is too big to update this way.");
  const short = { fetch: async (u, i) => (String(u).includes("/tarball/") ? new Response(tarball({ "README.md": { bytes: Buffer.from("x") } })) : gh.fetch(u, i)) };
  await assert.rejects(runUpdate({ ...opts(gh), fetch: short.fetch }), /archive has no/);
  const noText = { fetch: async (u, i) => { const r = await gh.fetch(u, i); return /\/git\/ref\//.test(String(u)) ? r : r.status === 404 ? new Response("nope", { status: 500 }) : r; } };
  await assert.rejects(runUpdate({ ...opts(gh), repo: "x/y", fetch: noText.fetch }), /GitHub answered 404/);
});

test("fingerprints match Git's, and the archive reader skips what isn't a file", async () => {
  for (const s of ["", "hello\n", "ünï ✓"]) assert.equal(await blobSha(new TextEncoder().encode(s)), gitSha(Buffer.from(s)));
  const files = untar(Buffer.from(require_gunzip(tarball({ "a.txt": { bytes: Buffer.from("A") } }))));
  assert.deepEqual([...files.keys()], ["a.txt"]);
  assert.equal(untar(new Uint8Array(1024)).size, 0, "an empty archive");
});
import { gunzipSync } from "node:zlib";
function require_gunzip(b) { return gunzipSync(b); }

test("the app signs a token GitHub accepts, from either kind of key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.deepEqual(Buffer.from(pemToPkcs8(pkcs1)), privateKey.export({ type: "pkcs8", format: "der" }), "PKCS#1 wrapped exactly as Node does");
  assert.deepEqual(Buffer.from(pemToPkcs8(pkcs8)), privateKey.export({ type: "pkcs8", format: "der" }));
  assert.throws(() => pemToPkcs8("nothing"), /No private key/);
  assert.equal(pkcs1ToPkcs8(new Uint8Array(10)).length, 10 + 22);
  const jwt = await appJwt(42, pkcs1, 1_700_000_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1_699_999_940, exp: 1_700_000_540, iss: "42" });
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), "signature checks out");
  const seen = [];
  const f = async (url, init) => { seen.push([init.method, new URL(url).pathname, init.headers.authorization.slice(0, 10)]); return new Response(JSON.stringify(url.endsWith("/installation") ? { id: 7 } : { token: "ghs_x" }), { status: url.endsWith("/installation") ? 200 : 201 }); };
  assert.equal(await installationToken({ appId: 42, pem: pkcs1, repo: "priya/site", fetch: f }), "ghs_x");
  assert.deepEqual(seen.map((x) => x.slice(0, 2)), [["GET", "/repos/priya/site/installation"], ["POST", "/app/installations/7/access_tokens"]]);
  const no = async () => new Response(JSON.stringify({ message: "Not installed" }), { status: 404 });
  await assert.rejects(installationToken({ appId: 42, pem: pkcs1, repo: "priya/site", fetch: no }), /404 for \/repos\/priya\/site\/installation: Not installed/);
  const bare = async () => new Response("", { status: 500 });
  await assert.rejects(installationToken({ appId: 42, pem: pkcs1, repo: "priya/site", fetch: bare }), /answered 500 for \/repos\/priya\/site\/installation$/);
});

// A Worker environment: KV in memory, the build's hello/config.json, the app in KV.
const env = ({ app, last, hello = { repo: "priya/site", templateRepo: "Alt-Carbon/tpl" } } = {}) => {
  const kv = new Map();
  if (app) kv.set("auth:app", JSON.stringify(app));
  if (last) kv.set(LAST_KEY, JSON.stringify(last));
  return {
    kv,
    BOOKS: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) },
    ASSETS: { fetch: async () => (hello ? new Response(JSON.stringify(hello)) : new Response("", { status: 404 })) },
  };
};

test("the weekly run: once a week, only with the app's key, and it records what happened", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const gh = fakeGitHub({ site: SITE, template: TEMPLATE });
  const f = async (url, init) => (/installation|access_tokens/.test(url) ? new Response(JSON.stringify(url.endsWith("/installation") ? { id: 1 } : { token: "ghs" }), { status: 200 }) : gh.fetch(url, init));
  assert.equal(await weekly(env({ app: { client_id: "c" } }), { fetch: f }), null, "an app from before the key was kept");
  const e = env({ app: { app_id: 9, pem } });
  const now = Date.parse("2026-11-23T08:00:00Z");
  const r = await weekly(e, { fetch: f, now });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.by, "weekly");
  assert.equal(JSON.parse(e.kv.get(LAST_KEY)).changed, true);
  assert.equal(await weekly(env({ app: { app_id: 9, pem }, last: { at: "2026-11-20T08:00:00Z" } }), { fetch: f, now }), null, "ran three days ago");
  const failing = await weekly(env({ app: { app_id: 9, pem }, last: { at: "2026-11-01T08:00:00Z" } }), { fetch: async () => new Response("", { status: 503 }), now });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /503/);
  // Without the build's config the update says why instead of guessing.
  const lost = await weekly(env({ app: { app_id: 9, pem }, hello: null }), { fetch: f, now });
  assert.equal(lost.reason, "The site doesn't know its repository.");
  const broken = { ...env({ app: { app_id: 9, pem } }), ASSETS: { fetch: async () => { throw new Error("no assets"); } } };
  assert.equal((await weekly(broken, { fetch: f, now })).reason, "The site doesn't know its repository.");
  const badKv = { ...env({ app: { app_id: 9, pem } }) };
  const realGet = badKv.BOOKS.get;
  badKv.BOOKS.get = async (k, t) => (k === LAST_KEY ? Promise.reject(new Error("kv down")) : realGet(k, t));
  assert.equal((await weekly(badKv, { fetch: f, now })).ok, true, "an unreadable last run does not block the update");
});

test("/auth/update: the last run, and Update now with the signed-in person's token", async () => {
  const gh = fakeGitHub({ site: SITE, template: TEMPLATE });
  const e = env({ app: { client_id: "c" } });
  const get = await (await updateRoute(new Request("https://s/auth/update"), e)).json();
  assert.deepEqual(get, { last: null, automatic: false });
  assert.equal((await updateRoute(new Request("https://s/auth/update", { method: "POST" }), e)).status, 401);
  assert.equal((await updateRoute(new Request("https://s/auth/update", { method: "DELETE" }), e)).status, 405);
  const res = await updateRoute(new Request("https://s/auth/update", { method: "POST", headers: { authorization: "Bearer ghu_1" } }), e, { fetch: gh.fetch });
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.by, "editor");
  const after = await (await updateRoute(new Request("https://s/auth/update"), env({ app: { app_id: 1, pem: "x" }, last: body }))).json();
  assert.equal(after.automatic, true);
  assert.equal(after.last.by, "editor");
  const badKv = env();
  badKv.BOOKS.get = async () => { throw new Error("kv down"); };
  assert.deepEqual(await (await updateRoute(new Request("https://s/auth/update"), badKv)).json(), { last: null, automatic: false });
});
