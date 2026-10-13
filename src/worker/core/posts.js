// Medium and Substack: where their public feeds live, and how their items become one shape of post.
// Runs anywhere with standard JS (Workers, Node, browsers). No DOM, no dependencies.
//
// Both platforms publish plain RSS 2.0 with the full text of each post:
//   Medium    https://medium.com/feed/@handle   the 10 newest stories; no subtitle, no cover field
//   Substack  https://<name>.substack.com/feed  the 20 newest posts; subtitle in <description>,
//             cover in <enclosure>; custom domains serve the same feed at /feed
// Neither goes further back, so older pieces still need an entry in the editor.

export const SOURCES = ["medium", "substack"];

// Accepts "@ev", "ev", a profile address in any of Medium's forms, a publication, or a feed address.
// Returns the feed to read and the page to link to, or null for an empty or foreign address.
export function mediumSource(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const handle = (h) => ({ feed: `https://medium.com/feed/@${h}`, url: `https://medium.com/@${h}` });
  if (/^@?[\w.-]+$/.test(s)) return handle(s.replace(/^@/, ""));
  let u;
  try {
    u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "medium.com") {
    const first = parts[0] === "feed" ? parts[1] : parts[0];
    if (!first) return null;
    if (first.startsWith("@")) return handle(first.slice(1));
    // A publication on medium.com: its feed is /feed/<name>.
    return { feed: `https://medium.com/feed/${first}`, url: `https://medium.com/${first}` };
  }
  if (host.endsWith(".medium.com")) return handle(host.slice(0, -".medium.com".length));
  // A publication on its own domain.
  return { feed: `${u.origin}/feed`, url: u.origin };
}

// Accepts "name", "name.substack.com", any address on the publication (its home, a post, the feed)
// or a custom domain. Returns the feed to read and the page to link to.
export function substackSource(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^[\w-]+$/.test(s)) return { feed: `https://${s}.substack.com/feed`, url: `https://${s}.substack.com` };
  let u;
  try {
    u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.hostname === "substack.com" || u.hostname === "www.substack.com") {
    // substack.com/@name is a profile, not a publication; the publication is name.substack.com.
    const m = /^\/@([\w-]+)/.exec(u.pathname);
    return m ? { feed: `https://${m[1]}.substack.com/feed`, url: `https://${m[1]}.substack.com` } : null;
  }
  return { feed: `${u.origin}/feed`, url: u.origin };
}

export const sourceFrom = (kind, input) => (kind === "medium" ? mediumSource(input) : substackSource(input));

// ---------- RSS ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });

const unwrap = (raw) => {
  const s = raw.trim();
  return s.startsWith("<![CDATA[") ? s.slice(9, s.lastIndexOf("]]>")).trim() : decode(s);
};

// Text of the first <tag> in `xml`, with or without attributes on the opening tag.
function tagText(xml, tag, from = 0) {
  for (let at = from; ; ) {
    const open = xml.indexOf(`<${tag}`, at);
    if (open === -1) return "";
    const after = xml[open + tag.length + 1];
    if (after !== ">" && after !== " " && after !== "\n" && after !== "\t") { at = open + 1; continue; }
    const start = xml.indexOf(">", open);
    if (start === -1) return "";
    if (xml[start - 1] === "/") return ""; // self-closing: no text
    const end = xml.indexOf(`</${tag}>`, start);
    if (end === -1) return "";
    return unwrap(xml.slice(start + 1, end));
  }
}

function tagAll(xml, tag) {
  const out = [];
  for (let at = 0; ; ) {
    const open = xml.indexOf(`<${tag}`, at);
    if (open === -1) return out;
    const start = xml.indexOf(">", open);
    const end = xml.indexOf(`</${tag}>`, start);
    if (start === -1 || end === -1) return out;
    out.push(unwrap(xml.slice(start + 1, end)));
    at = end + tag.length + 3;
  }
}

const attr = (tagXml, name) => {
  const m = new RegExp(`\\s${name}=["']([^"']*)["']`).exec(tagXml);
  return m ? decode(m[1]) : "";
};

// The channel: who the feed belongs to.
export function parseChannel(xml) {
  const end = xml.indexOf("<item>");
  const head = end === -1 ? xml : xml.slice(0, end);
  const image = tagText(head, "image");
  return {
    title: tagText(head, "title").replace(/\s+/g, " ").trim(),
    link: tagText(head, "link"),
    image: image ? tagText(image, "url") || null : null,
  };
}

// Every <item>, as the feed gives it.
export function parseItems(xml) {
  const items = [];
  for (let at = 0; ; ) {
    const from = xml.indexOf("<item>", at);
    if (from === -1) break;
    const to = xml.indexOf("</item>", from);
    if (to === -1) break;
    at = to + 7;
    const it = xml.slice(from + 6, to);
    const enc = /<enclosure\b[^>]*>/.exec(it);
    items.push({
      title: tagText(it, "title"),
      link: tagText(it, "link"),
      guid: tagText(it, "guid"),
      pubDate: tagText(it, "pubDate"),
      creator: tagText(it, "dc:creator"),
      description: tagText(it, "description"),
      content: tagText(it, "content:encoded"),
      categories: tagAll(it, "category"),
      enclosure: enc ? { url: attr(enc[0], "url"), type: attr(enc[0], "type") } : null,
    });
  }
  return items;
}

// ---------- text ----------
const strip = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// The first real paragraph of a post, for a blurb when the feed has no subtitle. Figures, captions,
// headings and anything shorter than a sentence are skipped.
export function firstParagraph(html) {
  if (!html) return "";
  const body = html.replace(/<figure[\s\S]*?<\/figure>/gi, " ").replace(/<figcaption[\s\S]*?<\/figcaption>/gi, " ");
  const paras = body.split(/<\/p>|<\/h[1-6]>|<\/blockquote>|<\/li>/i);
  for (const p of paras) {
    if (/<h[1-6][\s>]/i.test(p) && !/<p[\s>]/i.test(p)) continue;
    const text = strip(p);
    if (text.length < 40) continue;
    // A paragraph that is only a link (Medium's "read the announcement" lines) is not an opening.
    const a = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(p);
    if (a && strip(a[1]) === text) continue;
    return text;
  }
  return "";
}

// A subtitle with no letters or digits in it ("...") is no subtitle.
const said = (s) => (/[\p{L}\p{N}]/u.test(s) ? s : "");

export const excerpt = (text, max = 200) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).replace(/[,;:\-–—]$/, "").trim() + "…";
};

export const wordCount = (html) => (html ? strip(html).split(/\s+/).filter(Boolean).length : 0);

const firstImage = (html) => {
  const m = /<img\b[^>]*\ssrc=["']([^"']+)["']/i.exec(html || "");
  return m ? decode(m[1]) : null;
};

const day = (s) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

// The post's own address: Medium appends ?source=rss-…, and nothing a post links to needs a query.
export const cleanUrl = (s) => {
  try {
    const u = new URL(String(s || "").trim());
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
};

function idOf(source, item, url) {
  const g = item.guid || "";
  if (source === "medium") {
    const m = /\/p\/([0-9a-f]+)/.exec(g) || /-([0-9a-f]{8,})$/.exec(new URL(url).pathname);
    if (m) return `medium:${m[1]}`;
  }
  if (source === "substack") {
    const m = /\/p\/([^/?#]+)/.exec(g || url);
    if (m) return `substack:${m[1]}`;
  }
  let h = 2166136261;
  for (const ch of url) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return `${source}:${(h >>> 0).toString(16)}`;
}

// One post, the same shape from either platform.
export function normalise(source, item) {
  const url = cleanUrl(item.link) || cleanUrl(item.guid);
  if (!url || !item.title) return null;
  const words = wordCount(item.content);
  const enc = item.enclosure;
  const image = (enc && (/^image\//.test(enc.type) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(enc.url)) && enc.url) || firstImage(item.content);
  return {
    id: idOf(source, item, url),
    source,
    title: strip(item.title),
    url,
    date: day(item.pubDate),
    // Substack's <description> is the subtitle; Medium has none, so its opening paragraph stands in.
    blurb: excerpt(said(strip(item.description)) || firstParagraph(item.content)),
    image: image || null,
    tags: item.categories.map((c) => c.trim()).filter(Boolean),
    author: strip(item.creator) || null,
    words,
    minutes: words ? Math.max(1, Math.round(words / 230)) : null,
  };
}

// A whole feed: who it is, and its posts newest first.
export function parsePosts(source, xml) {
  const channel = parseChannel(xml);
  const name = source === "medium" ? channel.title.replace(/^Stories by\s+/i, "").replace(/\s+on Medium$/i, "") : channel.title;
  const posts = parseItems(xml).map((it) => normalise(source, it)).filter(Boolean)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { name: name || null, image: channel.image, posts };
}
