// A page the owner switched off in the editor is still built (the pages are static), but carries
// <meta name="alt-pages-off"> (src/layouts/Base.astro). Visitors get the site's "not found" page
// instead, with a 404. `finish` puts the site's address into that page, as for every page.
export const OFF = '<meta name="alt-pages-off"';

export async function notIfOff(request, env, res, finish = async (_req, r) => r) {
  if (res.status !== 200 || !(res.headers.get("content-type") || "").startsWith("text/html")) return res;
  const body = await res.text();
  if (!body.includes(OFF)) return new Response(body, res);
  const missing = await env.ASSETS.fetch(new URL("/404", request.url));
  const page = missing.ok ? await (await finish(request, missing)).text() : "Not found";
  return new Response(page, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
