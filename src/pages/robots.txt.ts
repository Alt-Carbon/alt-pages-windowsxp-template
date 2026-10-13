// Search engines may read everything except the editor, and are pointed at the sitemap.
import type { APIRoute } from "astro";
import { origin } from "../lib/content";

export const GET: APIRoute = ({ url }) =>
  new Response(`User-agent: *\nDisallow: /admin/\n\nSitemap: ${origin(url)}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
