import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isProtected, mergeLock, mergePackage, mergeWrangler, optedOut, parseJsonc, planUpdate, templateRepoOf } from "../scripts/update-from-template.mjs";

// A copy of the template's wrangler.jsonc (not the live file: in a deployed site that one has the
// site's own name and KV id, and these tests run there too), and a site's copy as the Deploy button
// leaves it: its own Worker name and the id of the KV namespace it created.
const WRANGLER = readFileSync(new URL("./fixtures/wrangler.jsonc", import.meta.url), "utf8");
const siteWrangler = (text = WRANGLER) => text.replace(`"name": "my-site"`, `"name": "asha-site"`).replace(`[{ "binding": "BOOKS" }]`, `[{ "binding": "BOOKS", "id": "0f1e2d3c" }]`);
const pkg = (name, extra = {}) => JSON.stringify({ name, version: "0.1.0", ...extra }, null, 2) + "\n";
const lock = (name, extra = {}) => JSON.stringify({ name, version: "0.1.0", lockfileVersion: 3, packages: { "": { name, version: "0.1.0" } }, ...extra }, null, 2) + "\n";

test("content, uploads and GitHub workflows are protected; code and configuration are not", () => {
  for (const p of ["content/site.json", "content/writing/a-piece.md", "public/media/photo.png", ".github/workflows/update.yml"]) assert.ok(isProtected(p), p);
  for (const p of ["src/pages/index.astro", "public/admin/index.html", "public/reading/view.json", "wrangler.jsonc", "package.json", "scripts/prepare.mjs", "contents.md", "public/mediakit.pdf"]) assert.ok(!isProtected(p), p);
});

test("the template repository comes from package.json, and only an explicit off stops updates", () => {
  assert.equal(templateRepoOf({ portfolio: { templateRepo: "Alt-Carbon/alt-pages-minimal-template" } }), "Alt-Carbon/alt-pages-minimal-template");
  assert.equal(templateRepoOf({}), "");
  assert.equal(templateRepoOf({ portfolio: { templateRepo: "not a repo" } }), "");
  assert.equal(optedOut({ advanced: { autoUpdate: false } }), true);
  assert.equal(optedOut({ advanced: { autoUpdate: true } }), false);
  assert.equal(optedOut({ advanced: {} }), false);
  assert.equal(optedOut({}), false);
});

test("parseJsonc reads comments and trailing commas, and leaves // and /* inside strings alone", () => {
  const w = parseJsonc(WRANGLER);
  assert.equal(w.name, "my-site");
  assert.ok(w.assets.run_worker_first.includes("!/_astro/*"));
  assert.equal(w.compatibility_date, "2026-10-01");
  assert.deepEqual(parseJsonc(`{ "a": "http://x/*y*/", // note\n "b": [1, 2,], /* c */ "c": -1.5e3, }`), { a: "http://x/*y*/", b: [1, 2], c: -1500 });
  assert.throws(() => parseJsonc(`{ "a": `));
});

test("wrangler.jsonc: the template's file, with the site's Worker name and KV namespace id", () => {
  // A change in the template: a newer compatibility date and a new comment.
  const template = WRANGLER.replace(`"2026-10-01"`, `"2026-11-01"`).replace(`"main":`, `// The script.\n  "main":`);
  const merged = mergeWrangler(template, siteWrangler());
  const m = parseJsonc(merged);
  assert.equal(m.name, "asha-site");
  assert.deepEqual(m.kv_namespaces, [{ binding: "BOOKS", id: "0f1e2d3c" }]);
  assert.equal(m.compatibility_date, "2026-11-01");
  assert.ok(merged.includes("// The script."));
  assert.ok(merged.includes("// Keep the free"), "the template's comments survive");
  // The durable object bindings are also called "name"; only the top-level one changes.
  assert.deepEqual(m.durable_objects.bindings.map((b) => b.name), ["SYNC", "POSTS"]);
  // Running it again on the result changes nothing.
  assert.equal(mergeWrangler(template, merged), merged);
});

test("wrangler.jsonc: a template KV binding the site lacks stays without an id; routes the person added are kept", () => {
  const template = WRANGLER.replace(`[{ "binding": "BOOKS" }]`, `[{ "binding": "BOOKS" }, { "binding": "EXTRA" }]`);
  const site = siteWrangler().replace(/\n}\s*$/, `,\n  "routes": [{ "pattern": "asha.example.com", "custom_domain": true }]\n}\n`);
  const m = parseJsonc(mergeWrangler(template, site));
  assert.deepEqual(m.kv_namespaces, [{ binding: "BOOKS", id: "0f1e2d3c" }, { binding: "EXTRA" }]);
  assert.deepEqual(m.routes, [{ pattern: "asha.example.com", custom_domain: true }]);
});

test("wrangler.jsonc: the same as the template when the site has nothing of its own; the site's file when it cannot be read", () => {
  assert.equal(mergeWrangler(WRANGLER, WRANGLER), WRANGLER);
  assert.equal(mergeWrangler(WRANGLER, "{ not json"), "{ not json");
});

test("package.json and package-lock.json: the template's, with the site's name", () => {
  const t = pkg("alt-pages-minimal-template", { dependencies: { astro: "^7.5.0" } });
  const merged = JSON.parse(mergePackage(t, pkg("asha-site", { dependencies: { astro: "^7.4.2" } })));
  assert.equal(merged.name, "asha-site");
  assert.deepEqual(merged.dependencies, { astro: "^7.5.0" });
  assert.equal(mergePackage(t, pkg("alt-pages-minimal-template")), t, "same name: the template's text, byte for byte");

  const l = JSON.parse(mergeLock(lock("alt-pages-minimal-template", { packages: { "": { name: "alt-pages-minimal-template", version: "0.2.0" } } }), lock("asha-site")));
  assert.equal(l.name, "asha-site");
  assert.deepEqual(l.packages[""], { name: "asha-site", version: "0.2.0" });
  assert.equal(mergeLock(lock("x"), lock("x")), lock("x"));
});

test("planUpdate copies changed code, skips protected files and removes files the template dropped", () => {
  const template = new Map([
    ["src/pages/index.astro", "new home"],
    ["src/lib/same.ts", "unchanged"],
    ["src/lib/new.ts", "a new file"],
    ["content/site.json", '{"name":"Template sample"}'],
    ["public/media/photo.png", "sample photo"],
    [".github/workflows/update.yml", "new workflow"],
    ["wrangler.jsonc", WRANGLER],
    ["package.json", pkg("alt-pages-minimal-template")],
  ]);
  const site = new Map([
    ["src/pages/index.astro", "old home"],
    ["src/lib/same.ts", "unchanged"],
    ["src/lib/gone.ts", "removed from the template"],
    ["content/site.json", '{"name":"Asha"}'],
    ["content/writing/mine.md", "my essay"],
    ["public/media/photo.png", "my photo"],
    ["public/media/cv.pdf", "my cv"],
    [".github/workflows/update.yml", "old workflow"],
    ["wrangler.jsonc", siteWrangler()],
    ["package.json", pkg("asha-site")],
  ]);
  const { write, remove } = planUpdate(template, site);
  assert.deepEqual([...write.keys()].sort(), ["src/lib/new.ts", "src/pages/index.astro"]);
  assert.equal(write.get("src/pages/index.astro").toString(), "new home");
  assert.deepEqual(remove, ["src/lib/gone.ts"]);
});

test("planUpdate does nothing when the site already matches the template", () => {
  const template = new Map([["src/a.ts", "a"], ["content/site.json", "sample"], ["wrangler.jsonc", WRANGLER], ["package.json", pkg("alt-pages-minimal-template")], ["package-lock.json", lock("alt-pages-minimal-template")]]);
  const site = new Map([["src/a.ts", Buffer.from("a")], ["content/site.json", "mine"], ["wrangler.jsonc", siteWrangler()], ["package.json", pkg("asha-site")], ["package-lock.json", lock("asha-site")]]);
  const { write, remove } = planUpdate(template, site);
  assert.equal(write.size, 0, [...write.keys()].join(", "));
  assert.deepEqual(remove, []);
});
