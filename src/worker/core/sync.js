// Fetches whole shelves through an injected fetch, so the same code runs in a
// Worker, in Node and in tests.

import { feedUrl, parseFeed, PAGE_SIZE } from "./feed.js";

export const UA ="PortfolioProject-ReadingSync/0.1 (personal site; reads the owner's own public shelf)";

export class FeedError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "FeedError";
    Object.assign(this, detail);
  }
}

export async function fetchPage({ userId, shelf, page = 1, fetch: f = fetch }) {
  const url = feedUrl(userId, shelf, page);
  const res = await f(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml" } });
  const type = res.headers.get("content-type") || "";
  const xml = await res.text();
  if (!res.ok || !type.includes("xml") || !xml.includes("<rss")) {
    throw new FeedError(`Goodreads answered ${res.status} for ${shelf} page ${page}`, {
      status: res.status,
      type,
      url,
      sample: xml.slice(0, 300),
    });
  }
  return { url, status: res.status, bytes: xml.length, books: parseFeed(xml) };
}

export async function fetchShelf({ userId, shelf, maxPages = 20, fetch: f = fetch }) {
  const seen = new Set();
  const books = [];
  for (let page = 1; page <= maxPages; page++) {
    const got = await fetchPage({ userId, shelf, page, fetch: f });
    for (const b of got.books) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      books.push(b);
    }
    if (got.books.length < PAGE_SIZE) break;
  }
  return books;
}

// One document per person. A book on several shelves appears once, with the
// first shelf asked for as its status.
export async function syncShelves({ userId, shelves = ["currently-reading", "read"], fetch: f = fetch, now = new Date() }) {
  const byId = new Map();
  for (const shelf of shelves) {
    for (const b of await fetchShelf({ userId, shelf, fetch: f })) {
      if (!byId.has(b.id)) byId.set(b.id, { ...b, status: shelf });
    }
  }
  return { version: 1, source: "goodreads", userId, syncedAt: now.toISOString(), books: [...byId.values()] };
}
