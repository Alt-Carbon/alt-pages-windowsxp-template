// Name and picture from the public profile page's Open Graph tags.
// The only place that reads HTML, so a sync treats any failure here as "no profile".

import { UA } from "./sync.js";

const og = (html, name) => {
  const m = new RegExp(`<meta[^>]+property=["']og:${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html);
  return m ? m[1].replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : null;
};

export async function fetchProfile({ userId, fetch: f = fetch }) {
  const res = await f(`https://www.goodreads.com/user/show/${userId}`, { headers: { "user-agent": UA, accept: "text/html" } });
  if (!res.ok) throw new Error(`Goodreads answered ${res.status} for the profile page`);
  const html = await res.text();
  const head = html.slice(0, html.indexOf("</head>") + 1 || 60000);
  const image = og(head, "image");
  return {
    name: og(head, "title"),
    image: image && !image.includes("nophoto") ? image : null,
    url: og(head, "url") || res.url,
  };
}
