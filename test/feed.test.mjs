import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { feedUrl, parseFeed, reviewText, userIdFrom } from "../src/worker/core/feed.js";
import { syncShelves, FeedError } from "../src/worker/core/sync.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const item = (o) => `<item>
<guid><![CDATA[https://www.goodreads.com/review/show/${o.id}?utm_medium=api]]></guid>
${o.link ? `<link><![CDATA[${o.link}]]></link>\n` : ""}<title>${o.title}</title>
<book_id>${o.id}</book_id>
<book_image_url><![CDATA[${o.cover ?? ""}]]></book_image_url>
<book_large_image_url><![CDATA[${o.cover ?? ""}]]></book_large_image_url>
<book_description><![CDATA[A long description with <b>markup</b> and a stray <title>trap</title>.]]></book_description>
<book id="${o.id}"><num_pages>${o.pages ?? ""}</num_pages></book>
<author_name>${o.author}</author_name>
<isbn>${o.isbn ?? ""}</isbn>
<user_rating>${o.rating ?? 0}</user_rating>
<average_rating>${o.avg ?? "0.00"}</average_rating>
<user_read_at><![CDATA[${o.readAt ?? ""}]]></user_read_at>
<user_date_added><![CDATA[${o.addedAt ?? ""}]]></user_date_added>
<user_shelves><![CDATA[${o.shelves ?? ""}]]></user_shelves>
<user_review><![CDATA[Private thoughts.]]></user_review>
<book_published>${o.published ?? ""}</book_published>
</item>`;
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Shelf</title>${items.join("\n")}</channel></rss>`;

test("userIdFrom reads ids, profile URLs and feed URLs", () => {
  assert.equal(userIdFrom("1234"), "1234");
  assert.equal(userIdFrom(" https://www.goodreads.com/user/show/1234-asha-rao "), "1234");
  assert.equal(userIdFrom("https://www.goodreads.com/review/list_rss/1234?shelf=read"), "1234");
  assert.equal(userIdFrom("https://www.goodreads.com/review/list/1234?shelf=read"), "1234");
  assert.equal(userIdFrom("https://example.com/asha"), null);
  assert.equal(userIdFrom(undefined), null);
});

test("feedUrl sorts the read shelf by date read", () => {
  assert.match(feedUrl("1", "read", 2), /shelf=read&sort=date_read&order=d&page=2$/);
  assert.match(feedUrl("1", "currently-reading"), /shelf=currently-reading&sort=date_added/);
});

test("parseFeed normalises one item", () => {
  const [b] = parseFeed(
    rss([
      item({
        id: "42",
        title: "Salt &amp; Stone &#8212; a history",
        author: "A.   Writer ",
        isbn: "159017416X",
        pages: 528,
        published: 1941,
        rating: 5,
        cover: "https://i.gr-assets.com/books/42.jpg",
        readAt: "Tue, 18 Aug 2026 00:00:00 +0000",
        addedAt: "Fri, 11 Sep 2026 10:07:58 -0700",
        shelves: "history, norway",
        avg: "4.12",
        link: "https://www.goodreads.com/review/show/9001?utm_medium=api&utm_source=rss",
      }),
    ])
  );
  assert.deepEqual(b, {
    id: "42",
    title: "Salt & Stone — a history",
    author: "A. Writer",
    isbn: "159017416X",
    pages: 528,
    published: 1941,
    cover: "https://i.gr-assets.com/books/42.jpg",
    rating: 5,
    avgRating: 4.12,
    readAt: "2026-08-18",
    addedAt: "2026-09-11",
    shelves: ["history", "norway"],
    review: "Private thoughts.",
    reviewUrl: "https://www.goodreads.com/review/show/9001",
    url: "https://www.goodreads.com/book/show/42",
  });
});

test("reviewText turns the review's HTML into paragraphs", () => {
  assert.equal(reviewText("Loved it.<br /><br />See <a href=\"https://example.com\">this</a> &amp; that. [spoilers removed]<br />"),
    "Loved it.\n\nSee this & that. [spoilers removed]");
  assert.equal(reviewText(""), null);
  assert.equal(reviewText("<br /> "), null);
});

test("parseFeed turns blanks and placeholders into null", () => {
  const [b] = parseFeed(rss([item({ id: "7", title: "Untitled", author: "Anon", cover: "https://s.gr-assets.com/assets/nophoto/book/111x148.png" })]));
  assert.equal(b.isbn, null);
  assert.equal(b.pages, null);
  assert.equal(b.published, null);
  assert.equal(b.cover, null);
  assert.equal(b.rating, null);
  assert.equal(b.avgRating, null);
  assert.equal(b.readAt, null);
  assert.deepEqual(b.shelves, []);
});

test("a missing field never borrows from the next item", () => {
  const first = item({ id: "1", title: "First", author: "A" }).replace(/<isbn>.*<\/isbn>\n/, "");
  const books = parseFeed(rss([first, item({ id: "2", title: "Second", author: "B", isbn: "999" })]));
  assert.equal(books[0].isbn, null);
  assert.equal(books[1].isbn, "999");
});

test("syncShelves pages until a short page and keeps each book once", async () => {
  const full = Array.from({ length: 100 }, (_, i) => item({ id: String(i + 1), title: `Book ${i + 1}`, author: "A" }));
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const shelf = u.searchParams.get("shelf");
    const page = u.searchParams.get("page");
    const items = shelf === "currently-reading" ? [item({ id: "1", title: "Book 1", author: "A" })] : page === "1" ? full : [item({ id: "101", title: "Book 101", author: "A" })];
    return new Response(rss(items), { headers: { "content-type": "application/xml" } });
  };
  const doc = await syncShelves({ userId: "9", fetch: fake, now: new Date("2026-09-29T00:00:00Z") });
  assert.equal(calls.length, 3);
  assert.equal(doc.books.length, 101);
  assert.equal(doc.books.find((b) => b.id === "1").status, "currently-reading");
  assert.equal(doc.books.find((b) => b.id === "2").status, "read");
  assert.equal(doc.syncedAt, "2026-09-29T00:00:00.000Z");
});

test("a block page raises FeedError with the status", async () => {
  const blocked = async () => new Response("<html>Access denied</html>", { status: 403, headers: { "content-type": "text/html" } });
  await assert.rejects(syncShelves({ userId: "9", fetch: blocked }), (e) => e instanceof FeedError && e.status === 403);
});

test("a private profile answering 200 with HTML raises FeedError", async () => {
  const signIn = async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(syncShelves({ userId: "9", fetch: signIn }), FeedError);
});

test("real feed page parses fully", { skip: (() => { try { fixture("read-p1.xml"); return false; } catch { return "no fixture saved"; } })() }, () => {
  const books = parseFeed(fixture("read-p1.xml"));
  assert.equal(books.length, 100);
  for (const b of books) {
    assert.match(b.id, /^\d+$/);
    assert.ok(b.title && b.author);
    assert.ok(!b.title.includes("<"));
  }
});

test("parseFeed reads the average rating and review link from a real feed", () => {
  const books = parseFeed(fixture("read-p1.xml"));
  assert.equal(books.length, 100);
  assert.ok(books.every((b) => b.avgRating === null || (b.avgRating > 0 && b.avgRating <= 5)));
  assert.ok(books.filter((b) => b.avgRating).length > 90);
  assert.ok(books.every((b) => b.reviewUrl === null || /^https:\/\/www\.goodreads\.com\/review\/show\/\d+$/.test(b.reviewUrl)));
  assert.ok(books.filter((b) => b.reviewUrl).length > 90);
});
