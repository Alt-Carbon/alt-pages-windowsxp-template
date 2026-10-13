// The plain list: every book and every field, grouped as Reading now, then by year read. It is what
// prints, and the fallback if a style fails to load.
import { type Shelf, day, esc, facts, groups, human, links, paragraphs, stars } from "./shared";

export function renderList(shelf: Shelf, root: HTMLElement) {
  const row = (b: Book) => {
    const meta = [
      b.rating ? stars(b.rating) : "",
      b.now ? "Reading now" : b.readAt ? `Read ${day(b.readAt)}` : "",
      ...facts(b).filter(([k]) => k !== "Read").map(([k, v]) => (k === "Pages" ? `${v} pages` : k === "First published" ? `First published ${v}` : k === "Goodreads avg" ? `${v} on Goodreads` : k === "Added" ? `Added ${v}` : `${k} ${esc(v)}`)),
    ].filter(Boolean).map((m) => `<span>${m}</span>`).join("");
    const tags = b.shelves?.length ? `<p class="tags">${b.shelves.map((s) => `<span>${esc(human(s))}</span>`).join("")}</p>` : "";
    const review = b.review ? `<blockquote>${paragraphs(b.review)}</blockquote>` : "";
    const cover = b.cover ? `<img class="cover" src="${esc(b.cover)}" alt="" loading="lazy" width="56" height="84">` : '<span class="cover none" aria-hidden="true"></span>';
    return `<li>${cover}<div><h3><a href="${esc(b.url)}">${esc(b.title)}</a></h3><p class="by">${esc(b.author)}</p>`
      + `${meta ? `<p class="meta">${meta}</p>` : ""}${tags}${review}<p class="links">${links(b).join("")}</p></div></li>`;
  };
  let html = "";
  for (const [name, bs] of groups(shelf.books)) {
    html += `<h2>${esc(name)} <span class="count">${bs.length}</span></h2><ul class="booklist">${bs.map(row).join("")}</ul>`;
  }
  root.innerHTML = html;
  return shelf.books.length;
}
type Book = Shelf["books"][number];
