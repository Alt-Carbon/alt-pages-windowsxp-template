// The writing as an RSS feed, full text included. Addresses are absolute: the Worker fills in the
// site's own address (see origin() in src/lib/content.ts).
import type { APIRoute } from "astro";
import { origin, site, summary, writing } from "../lib/content";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

export const GET: APIRoute = async ({ url }) => {
  const base = origin(url);
  const posts = await writing();
  const items = posts.map((p) => {
    const link = p.data.link || `${base}/writing/${p.id}`;
    const html = !p.data.link && p.rendered?.html;
    return `<item><title>${esc(p.data.title)}</title><link>${esc(link)}</link><guid isPermaLink="true">${esc(link)}</guid>`
      + `<pubDate>${p.data.date.toUTCString()}</pubDate><description>${esc(summary(p))}</description>`
      + (html ? `<content:encoded>${cdata(html)}</content:encoded>` : "") + `</item>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>${esc(site.name)}</title><link>${base}/</link><description>${esc(`${site.oneLiner} ${site.intro}`.trim())}</description><language>en</language>
<atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml"/>${posts[0] ? `<lastBuildDate>${posts[0].data.date.toUTCString()}</lastBuildDate>` : ""}
${items}
</channel></rss>`;
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
};
