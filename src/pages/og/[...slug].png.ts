// A link-preview card for every page, made at build time from the content: what Slack, LinkedIn,
// WhatsApp and search results show when someone shares a link.
import type { APIRoute, GetStaticPaths } from "astro";
import { cardPng, type Card } from "../../lib/cards";
import { about, day, now, reading, research, site, summary, writing } from "../../lib/content";

// Card text is plain: inline Markdown markers are dropped.
const plain = (s = "") => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "");

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await writing();
  const cards: Record<string, Card> = {
    home: { title: plain(site.oneLiner), subtitle: plain(site.intro) },
    writing: { title: "Writing", subtitle: posts[0] ? `Latest: ${posts[0].data.title}` : undefined, kicker: `${posts.length} ${posts.length === 1 ? "piece" : "pieces"}` },
    research: { title: "Research", subtitle: plain(research.intro), kicker: `${research.items.length} ${research.items.length === 1 ? "item" : "items"}` },
    reading: { title: "Reading", subtitle: plain(reading.intro) },
    now: { title: "Now", subtitle: plain(now.groups[0]?.items[0]), kicker: `Updated ${day(now.updated)}` },
    about: { title: "About", subtitle: plain(about.shortBio || about.paragraphs[0]) },
  };
  for (const p of posts.filter((p) => !p.data.link)) {
    cards[`writing/${p.id}`] = { title: p.data.title, subtitle: summary(p), kicker: `Writing · ${day(p.data.date)}` };
  }
  return Object.entries(cards).map(([slug, card]) => ({ params: { slug }, props: { card } }));
};

export const GET: APIRoute = async ({ props }) => new Response(await cardPng(props.card as Card), { headers: { "content-type": "image/png" } });
