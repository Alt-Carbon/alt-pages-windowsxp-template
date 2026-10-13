// Regenerates the sample posts shown on the Writing page until a site connects Medium or Substack,
// from real public feeds, with the same code the site's Worker runs. Defaults: Ev Williams on Medium
// (@ev, who founded it) and the On Substack newsletter (on.substack.com, Substack's own).
// Usage: npm run sample:posts [-- <medium> <substack>]   ("-" skips one)
//
// Writes public/writing/elsewhere.json, the shape /writing/elsewhere.json serves once synced.
import { mkdirSync, writeFileSync } from "node:fs";
import { SOURCES, mediumSource, parsePosts, substackSource } from "../src/worker/core/posts.js";
import { buildView, fetchFeed, freshMeta } from "../src/worker/posts-store.js";

const [m = "@ev", s = "on"] = process.argv.slice(2);
const sources = { medium: m === "-" ? null : mediumSource(m), substack: s === "-" ? null : substackSource(s) };
if (!sources.medium && !sources.substack) throw new Error("Give a Medium handle or address, a Substack address, or both.");

const meta = freshMeta(sources);
const at = new Date().toISOString();
const kept = {};
for (const k of SOURCES) {
  if (!sources[k]) continue;
  const xml = await fetchFeed(sources[k].feed);
  kept[k] = { ...parsePosts(k, xml), at };
  process.stdout.write(`${k}: ${kept[k].name ?? "?"}, ${kept[k].posts.length} posts, ${Math.round(xml.length / 1024)} KB\n`);
}
meta.syncedAt = at;
const view = { sample: true, ...buildView(meta, kept, null) };
mkdirSync("public/writing", { recursive: true });
writeFileSync("public/writing/elsewhere.json", JSON.stringify(view) + "\n");
console.log(`public/writing/elsewhere.json: ${view.posts.length} posts, ${Math.round(Buffer.byteLength(JSON.stringify(view)) / 1024)} KB`);
