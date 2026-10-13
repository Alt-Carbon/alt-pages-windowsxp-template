// Goodreads shelf feed: URL building and parsing.
// Runs anywhere with standard JS (Workers, Node, browsers). No DOM, no dependencies.

const FEED = "https://www.goodreads.com/review/list_rss/";
export const PAGE_SIZE = 100; // fixed by Goodreads; per_page is ignored

// Accepts a bare id ("1234"), a profile URL (.../user/show/1234-name) or a feed URL.
export function userIdFrom(input) {
  const m = String(input ?? "").trim().match(/(?:user\/show\/|review\/list(?:_rss)?\/|^)(\d+)/);
  return m ? m[1] : null;
}

export function feedUrl(userId, shelf = "read", page = 1) {
  const sort = shelf === "read" ? "date_read" : "date_added";
  return `${FEED}${userId}?shelf=${encodeURIComponent(shelf)}&sort=${sort}&order=d&page=${page}`;
}

// Covers live at .../books/<stamp>/<id>[._SX98_].jpg. The stamp and id are all
// that is kept, so a site can serve covers from its own address at any width.
export function coverPath(url) {
  const m = /\/books\/(\d+[a-z]?)\/(\d+)\./.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

export const coverSource = (path, width = 300) =>
  `https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/${path}._SX${width}_.jpg`;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });

// Text of <tag> between two offsets. indexOf only, so the long descriptions
// in each item are skipped over rather than matched against.
function field(xml, from, to, tag) {
  const open = xml.indexOf(`<${tag}>`, from);
  if (open === -1 || open > to) return "";
  const start = open + tag.length + 2;
  const end = xml.indexOf(`</${tag}>`, start);
  if (end === -1 || end > to) return "";
  const raw = xml.slice(start, end).trim();
  return raw.startsWith("<![CDATA[") ? raw.slice(9, raw.lastIndexOf("]]>")).trim() : decode(raw);
}

const int = (s) => (/^\d+$/.test(s) ? Number(s) : null);
const num = (s) => (/^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : null);
// The review's own page, without Goodreads' tracking parameters.
const reviewLink = (s) => (/^https:\/\/www\.goodreads\.com\/review\/show\//.test(s) ? s.split("?")[0] : null);
const day = (s) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};
const squash = (s) => s.replace(/\s+/g, " ").trim();
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

// The review comes as HTML with <br> and links. Kept as plain text, paragraphs
// separated by blank lines. Goodreads has already replaced spoilers with the
// words "[spoilers removed]". Descriptions are left out.
export const reviewText = (html) => {
  if (!html) return null;
  const text = decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
};

export function parseFeed(xml) {
  const books = [];
  let at = 0;
  for (;;) {
    const from = xml.indexOf("<item>", at);
    if (from === -1) break;
    const to = xml.indexOf("</item>", from);
    if (to === -1) break;
    at = to + 7;

    const id = field(xml, from, to, "book_id");
    if (!id) continue;
    const cover = field(xml, from, to, "book_large_image_url") || field(xml, from, to, "book_image_url");
    books.push({
      id,
      // Goodreads pads some names with runs of spaces.
      title: squash(field(xml, from, to, "title")),
      author: squash(field(xml, from, to, "author_name")),
      isbn: field(xml, from, to, "isbn") || null,
      pages: int(field(xml, from, to, "num_pages")),
      published: int(field(xml, from, to, "book_published")),
      cover: cover && !cover.includes("nophoto") ? cover : null,
      rating: int(field(xml, from, to, "user_rating")) || null,
      avgRating: num(field(xml, from, to, "average_rating")),
      readAt: day(field(xml, from, to, "user_read_at")),
      addedAt: day(field(xml, from, to, "user_date_added")),
      shelves: list(field(xml, from, to, "user_shelves")),
      review: reviewText(field(xml, from, to, "user_review")),
      reviewUrl: reviewLink(field(xml, from, to, "link") || field(xml, from, to, "guid")),
      url: `https://www.goodreads.com/book/show/${id}`,
    });
  }
  return books;
}
