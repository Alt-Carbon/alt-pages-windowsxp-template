import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanUrl, excerpt, firstParagraph, mediumSource, normalise, parseChannel, parseItems, parsePosts, substackSource } from "../src/worker/core/posts.js";
import { buildView, freshMeta, postsName, runPosts } from "../src/worker/posts-store.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("mediumSource reads handles, profiles, subdomains, publications and feeds", () => {
  const ev = { feed: "https://medium.com/feed/@ev", url: "https://medium.com/@ev" };
  for (const s of ["@ev", "ev", " https://medium.com/@ev ", "https://medium.com/@ev/some-story-0126fa5c6ce8", "https://ev.medium.com/", "https://ev.medium.com/feed", "https://medium.com/feed/@ev", "medium.com/@ev"]) {
    assert.deepEqual(mediumSource(s), ev, s);
  }
  assert.deepEqual(mediumSource("https://medium.com/the-story"), { feed: "https://medium.com/feed/the-story", url: "https://medium.com/the-story" });
  assert.deepEqual(mediumSource("https://blog.example.com/"), { feed: "https://blog.example.com/feed", url: "https://blog.example.com" });
  assert.equal(mediumSource(""), null);
  assert.equal(mediumSource(undefined), null);
  assert.equal(mediumSource("https://medium.com/"), null);
});

test("substackSource reads names, publications, posts, profiles and custom domains", () => {
  const on = { feed: "https://on.substack.com/feed", url: "https://on.substack.com" };
  for (const s of ["on", "on.substack.com", "https://on.substack.com", "https://on.substack.com/p/a-post?utm=x", "https://on.substack.com/feed"]) {
    assert.deepEqual(substackSource(s), on, s);
  }
  assert.deepEqual(substackSource("https://substack.com/@casey"), { feed: "https://casey.substack.com/feed", url: "https://casey.substack.com" });
  assert.deepEqual(substackSource("https://www.astralcodexten.com/"), { feed: "https://www.astralcodexten.com/feed", url: "https://www.astralcodexten.com" });
  assert.equal(substackSource(""), null);
  assert.equal(substackSource("https://substack.com/"), null);
});

test("a Medium feed: who it is, and posts with a clean link, a date, tags and an opening-paragraph blurb", () => {
  const got = parsePosts("medium", fixture("medium.xml"));
  assert.equal(got.name, "Ev Williams");
  assert.match(got.image, /^https:\/\/cdn-images-1\.medium\.com\//);
  assert.equal(got.posts.length, 2);
  const p = got.posts[0];
  assert.equal(p.id, "medium:0126fa5c6ce8");
  assert.equal(p.source, "medium");
  assert.equal(p.title, "Making “Social” Social Again");
  assert.equal(p.url, "https://ev.medium.com/making-social-social-again-0126fa5c6ce8"); // ?source=rss… dropped
  assert.equal(p.date, "2024-12-12");
  assert.deepEqual(p.tags, ["social", "startupş", "relationships"]);
  assert.equal(p.author, "Ev Williams");
  // Not the announcement link that comes first, the first real paragraph.
  assert.match(p.blurb, /^I think it’s tough to appreciate/);
  assert.ok(p.blurb.length <= 201, p.blurb);
  assert.match(p.image, /^https:\/\/cdn-images-1\.medium\.com\/max\/1024\//);
  assert.ok(p.words > 100 && p.minutes >= 1);
});

test("a Substack feed: the subtitle is the blurb, the enclosure is the image", () => {
  const got = parsePosts("substack", fixture("substack.xml"));
  assert.equal(got.name, "On Substack");
  assert.match(got.image, /^https:\/\/substackcdn\.com\//);
  assert.equal(got.posts.length, 2);
  const p = got.posts[0];
  assert.equal(p.id, "substack:a-new-vision-for-sponsorships");
  assert.equal(p.url, "https://on.substack.com/p/a-new-vision-for-sponsorships");
  assert.equal(p.date, "2026-10-08");
  assert.equal(p.blurb, "On clubbing, Boston Market, and more ways to earn on Substack");
  assert.match(p.image, /^https:\/\/substackcdn\.com\/image\//);
  assert.equal(p.author, "Dan @ Substack");
});

const item = (o) => `<item><title><![CDATA[${o.title ?? "A post"}]]></title>${o.link ? `<link>${o.link}</link>` : ""}<guid isPermaLink="false">${o.guid ?? ""}</guid>
<pubDate>${o.pubDate ?? "Mon, 12 Oct 2026 09:00:00 GMT"}</pubDate>${o.description != null ? `<description><![CDATA[${o.description}]]></description>` : ""}
${o.enclosure ?? ""}<content:encoded><![CDATA[${o.content ?? "<p>Enough words here to count as a paragraph of the post itself.</p>"}]]></content:encoded></item>`;
const rss = (items, title = "Shelf") => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://x.test</link>${items.join("")}</channel></rss>`;

test("normalise: a subtitle of dots is no subtitle; a link-only paragraph is skipped; audio enclosures are not covers", () => {
  const [a, b] = parseItems(rss([
    item({ link: "https://x.substack.com/p/one", description: "...", content: "<h3>Heading</h3><p><a href='https://e.test'>A headline that is only a link, long enough to pass the length test</a></p><p>The real opening of the post, which is what the blurb should be made from.</p>" }),
    item({ link: "https://x.substack.com/p/two", enclosure: `<enclosure url="https://x.test/ep.mp3" type="audio/mpeg" length="1"/>`, content: "<p>Short.</p>" }),
  ]));
  const p = normalise("substack", a);
  assert.equal(p.blurb, "The real opening of the post, which is what the blurb should be made from.");
  assert.equal(p.id, "substack:one");
  const q = normalise("substack", b);
  assert.equal(q.image, null);
  assert.equal(q.blurb, "");
  assert.equal(q.minutes, 1);
});

test("normalise: no link and no guid means no post; a guid stands in for a missing link", () => {
  const [a, b] = parseItems(rss([item({ guid: "" }), item({ guid: "https://medium.com/p/abc123" })]));
  assert.equal(normalise("medium", a), null);
  assert.equal(normalise("medium", b).url, "https://medium.com/p/abc123");
  assert.equal(normalise("medium", b).id, "medium:abc123");
});

test("text helpers", () => {
  assert.equal(cleanUrl("https://ev.medium.com/x-1?source=rss-1#frag"), "https://ev.medium.com/x-1");
  assert.equal(cleanUrl("not a url"), null);
  assert.equal(excerpt("a ".repeat(200), 20).length <= 21, true);
  assert.equal(excerpt("short"), "short");
  assert.equal(firstParagraph("<figure><img src=x><figcaption>A caption that is long enough to be a paragraph otherwise</figcaption></figure><p>Hello there, this is the first paragraph of the piece.</p>"), "Hello there, this is the first paragraph of the piece.");
  assert.equal(parseChannel(rss([], "Stories by A on Medium")).title, "Stories by A on Medium");
});

test("a run keeps a source's last posts when its feed fails, and still refreshes the other", async () => {
  const sources = { medium: mediumSource("@ev"), substack: substackSource("on") };
  const meta = freshMeta(sources);
  assert.equal(meta.name, "https://medium.com/feed/@ev|https://on.substack.com/feed");
  assert.equal(postsName({ medium: null, substack: sources.substack }), "|https://on.substack.com/feed");
  const store = new Map();
  const storage = { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) };
  const kv = new Map();
  const env = { BOOKS: { put: async (k, v) => void kv.set(k, v) } };
  const ok = (xml) => new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml" } });
  const bad = () => new Response("<html>Blocked</html>", { status: 403, headers: { "content-type": "text/html" } });

  let view = await runPosts(env, storage, meta, "test", async (url) => ok(url.includes("medium") ? fixture("medium.xml") : fixture("substack.xml")));
  assert.equal(meta.lastRun.ok, true);
  assert.equal(view.posts.length, 4);
  assert.equal(view.posts[0].source, "substack"); // newest first across both
  assert.equal(view.sources.medium.name, "Ev Williams");
  assert.ok(meta.syncedAt);

  const first = meta.syncedAt;
  view = await runPosts(env, storage, meta, "test", async (url) => (url.includes("medium") ? bad() : ok(fixture("substack.xml"))));
  assert.equal(meta.lastRun.ok, false);
  assert.equal(meta.lastRun.sources.medium.ok, false);
  assert.equal(meta.lastRun.sources.medium.kept, 2);
  assert.equal(view.posts.length, 4, "Medium's last posts are kept");
  assert.ok(meta.syncedAt >= first, "a run that read a feed still counts as a sync");
  assert.ok(kv.has(meta.name) || kv.has(`posts:${meta.name}`));

  const parsed = JSON.parse(kv.get(`posts:${meta.name}`));
  assert.equal(parsed.posts.length, 4);
  assert.deepEqual(Object.keys(buildView(meta, {}, null).sources), ["medium", "substack"]);
});
