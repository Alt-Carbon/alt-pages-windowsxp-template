// Every page, for search engines. Pieces published elsewhere are left out.
import type { APIRoute } from "astro";
import { freshness, menu, now, origin, writing } from "../lib/content";

export const GET: APIRoute = async ({ url }) => {
  const base = origin(url);
  const posts = await writing();
  const fresh = await freshness();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const urls: [string, string | undefined][] = [
    ["/", fresh.date],
    ...(await menu()).map((p): [string, string | undefined] => [p.href, p.id === "now" ? now.updated : p.id === "writing" && posts[0] ? day(posts[0].data.date) : undefined]),
    ...posts.filter((p) => !p.data.link).map((p): [string, string] => [`/writing/${p.id}`, day(p.data.date)]),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([path, mod]) => `<url><loc>${base}${path}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
