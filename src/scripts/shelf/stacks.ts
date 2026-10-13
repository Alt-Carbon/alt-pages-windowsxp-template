// Bookshelf style "stacks" (from protos/bookshelf-b-stacks.html). Books lie flat in piles on a
// table, spines toward you, so the titles read horizontally. Each group (Reading now, then the
// years, or the person's Goodreads shelves) is a pile, big groups split into piles of at most
// twelve. Hover or focus slides a book out and names it in the caption; pressing it opens a side
// drawer with the cover, the facts and the full review, with prev/next through the pile.
import "../../styles/shelf/stacks.css";
import { type Book, type GroupBy, type Shelf, type Style, NOW, esc, facts, groups, hash, hex, human, links, n, pageSignal, paragraphs, reduced, rgbOf, sampleAll, short, stars, surname, textOn, usesShelves } from "./shared";

type Pile = { name: string; part: number; parts: number; books: Book[] };
const PER = 12;
const MINF = 12;

export const render: Style = (shelf, root) => {
  const books = shelf.books;
  const byId = new Map(books.map((b) => [b.id, b]));
  const key = new Map(books.map((b) => [b.id, hash(b.title + b.author)]));
  const k = (b: Book) => key.get(b.id)!;
  const who = shelf.owner;
  const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = root) => r.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = root) => [...r.querySelectorAll<T>(s)];

  // ---------- the page ----------
  root.innerHTML = `<div class="controls" role="toolbar" aria-label="Shelf controls">`
    + `<label class="search"><span class="vh">Find a title or author</span><input type="search" placeholder="Find a title or author" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label>`
    + (usesShelves(books) ? `<div class="seg" role="group" aria-label="Group by"><button type="button" data-group="year" aria-pressed="true">By year</button><button type="button" data-group="shelf" aria-pressed="false">By shelf</button></div>` : "")
    + `</div><div class="view"></div><p class="vh" aria-live="polite"></p>`
    + `<dialog class="shelf-stacks-drawer" aria-labelledby="shelf-stacks-title">`
    + `<div class="dbar"><span class="dfrom"></span><span class="grow"></span><span class="dpos"></span>`
    + `<button class="ibtn prev" type="button" aria-label="Previous book in this pile" aria-keyshortcuts="ArrowLeft"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button>`
    + `<button class="ibtn next" type="button" aria-label="Next book in this pile" aria-keyshortcuts="ArrowRight"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>`
    + `<button class="ibtn close" type="button" aria-label="Close" autofocus><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>`
    + `<div class="dscroll"><div class="dhead"><div class="dcover"></div><div><h2 id="shelf-stacks-title"></h2><p class="dby"></p><p class="dstars"></p></div></div>`
    + `<div class="dbody"><div class="actions"></div><dl class="facts"></dl><div class="shelves"></div><div class="review"></div></div></div></dialog>`;

  const view = $(".view"), live = $("[aria-live]"), q = $<HTMLInputElement>(".search input");
  const dlg = $<HTMLDialogElement>(".shelf-stacks-drawer");
  const d = {
    from: $(".dfrom", dlg), pos: $(".dpos", dlg), prev: $<HTMLButtonElement>(".prev", dlg), next: $<HTMLButtonElement>(".next", dlg),
    scroll: $(".dscroll", dlg), cover: $(".dcover", dlg), title: $(".dhead h2", dlg), by: $(".dby", dlg), stars: $(".dstars", dlg),
    actions: $(".actions", dlg), facts: $(".facts", dlg), shelves: $(".shelves", dlg), review: $(".review", dlg),
  };

  // ---------- groups and piles ----------
  let groupBy: GroupBy = "year", query = "", piles: Pile[] = [];
  const filtered = () => {
    const s = query.trim().toLowerCase();
    return s ? books.filter((b) => b.title.toLowerCase().includes(s) || b.author.toLowerCase().includes(s)) : books;
  };
  // Big groups split into even piles of at most PER books.
  const toPiles = (gs: [string, Book[]][]): Pile[] => {
    const out: Pile[] = [];
    for (const [name, bs] of gs) {
      const parts = Math.ceil(bs.length / PER), size = Math.ceil(bs.length / parts);
      for (let p = 0; p < parts; p++) out.push({ name, part: p + 1, parts, books: bs.slice(p * size, (p + 1) * size) });
    }
    return out;
  };

  // ---------- render ----------
  const bookHTML = (b: Book, j: number, len: number, pi: number) => {
    const h = Math.round(Math.min(44, Math.max(18, (b.pages || 280) / 14)));
    const w = 70 + (k(b) % 25); // 70–94% of the pile
    const x = ((k(b) >>> 5) % 21) - 10; // ±10, scaled to the pile's width
    const r = (k(b) >>> 10) % 3 === 0 ? (((k(b) >>> 12) % 25) - 12) / 10 : 0; // occasional ±1.2°
    const fs = Math.min(18, Math.max(12.5, h * 0.48)).toFixed(1);
    const rgb = rgbOf(b);
    const cls = ["bk", k(b) % 5 === 0 ? "band" : "", (k(b) >>> 3) % 6 === 0 ? "it" : "", b.now ? "now" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${cls}" data-id="${esc(b.id)}" data-p="${pi}" data-fs="${fs}" tabindex="${j === 0 ? 0 : -1}" aria-label="${esc(`${b.title}, ${b.author}`)}" `
      + `style="--h:${h}px;--w:${w}%;--x:${x};--r:${r}deg;--fs:${fs}px;--c:${hex(rgb)};--t:${textOn(rgb)};--j:${len - 1 - j}">`
      + `<span class="ti">${esc(short(b.title))}</span><span class="au">${esc(surname(b.author))}</span>${b.now ? `<i class="rib"></i>` : ""}</button>`;
  };
  const restCaption = (p: Pile) => {
    const pages = p.books.reduce((s, b) => s + (b.pages || 0), 0);
    return `${p.books.length} ${p.books.length === 1 ? "book" : "books"}${pages ? ` · ${n(pages)} pages` : ""}`;
  };
  function draw(animate = false) {
    const list = filtered();
    piles = toPiles(groups(list, groupBy));
    if (!list.length) {
      view.innerHTML = `<p class="empty">No books match “${esc(query)}”. <button type="button" class="clear">Clear the search</button></p>`;
      live.textContent = "No books match";
      return;
    }
    view.innerHTML = `<div class="table${animate && !reduced() ? " drop" : ""}">` + piles.map((p, pi) => {
      const part = p.parts > 1 ? `<span class="part">· ${p.part} of ${p.parts}</span>` : "";
      const dot = p.name === NOW ? `<span class="dot" aria-hidden="true"></span>` : "";
      const count = `${p.books.length} ${p.books.length === 1 ? "book" : "books"}`;
      return `<section class="cell" aria-labelledby="shelf-stacks-p${pi}" style="--pd:${pi % 3}">`
        + `<div class="label">${dot}<h2 id="shelf-stacks-p${pi}">${esc(p.name)}</h2>${part}<span class="n" aria-hidden="true">${p.books.length}</span></div>`
        + `<div class="pile" role="group" aria-label="${esc(p.name)}${p.parts > 1 ? `, pile ${p.part} of ${p.parts}` : ""}, ${count}">`
        + p.books.map((b, j) => bookHTML(b, j, p.books.length, pi)).join("") + `</div>`
        + `<div class="plank" aria-hidden="true"></div><p class="caption" aria-hidden="true">${restCaption(p)}</p></section>`;
    }).join("") + `</div>`;
    fit();
    live.textContent = query ? `${list.length} ${list.length === 1 ? "book" : "books"} match` : "";
    if (dlg.open && cur) markOpen(cur.b.id);
  }

  // Titles shrink a little to fit their spine; if a title still doesn’t fit, the surname makes way
  // (the caption and the drawer still name the author).
  function fit() {
    const els = $$(".bk", view);
    const ti = (el: HTMLElement) => el.firstElementChild as HTMLElement;
    const ratio = (el: HTMLElement) => ti(el).clientWidth / ti(el).scrollWidth;
    const base = (el: HTMLElement) => +el.dataset.fs!;
    for (const el of els) { el.classList.remove("noau"); el.style.setProperty("--fs", `${base(el)}px`); }
    const over = els.map((el) => [el, ratio(el)] as const).filter(([, r]) => r < 0.995);
    for (const [el, r] of over) el.style.setProperty("--fs", `${Math.max(MINF, base(el) * r * 0.96).toFixed(1)}px`);
    const tight = over.map(([el]) => [el, ratio(el)] as const).filter(([, r]) => r < 0.995).map(([el]) => el);
    for (const el of tight) { el.classList.add("noau"); el.style.setProperty("--fs", `${base(el)}px`); }
    for (const el of tight) { const r = ratio(el); if (r < 0.995) el.style.setProperty("--fs", `${Math.max(MINF, base(el) * r * 0.96).toFixed(1)}px`); }
  }
  let fitRaf = 0;
  addEventListener("resize", () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fit); }, { signal: pageSignal() });
  document.fonts?.ready.then(fit);

  // ---------- interactions on the table ----------
  const bookOf = (el: HTMLElement) => byId.get(el.dataset.id!)!;
  const pileOf = (el: HTMLElement) => piles[+el.dataset.p!]!;
  function caption(el: HTMLElement, on: boolean) {
    const cap = el.closest(".cell")?.querySelector(".caption");
    if (!cap) return;
    if (!on) { cap.innerHTML = restCaption(pileOf(el)); return; }
    const b = bookOf(el);
    cap.innerHTML = `<b>${esc(short(b.title))}</b> · ${esc(b.author)}${b.rating ? ` <span class="st">${"★".repeat(b.rating)}</span>` : ""}`;
  }
  const bk = (e: Event) => (e.target as Element).closest<HTMLElement>(".bk");
  view.addEventListener("pointerover", (e) => { const el = bk(e); if (el) caption(el, true); });
  view.addEventListener("pointerout", (e) => {
    const el = bk(e);
    if (el && !el.contains(e.relatedTarget as Node) && document.activeElement !== el) caption(el, false);
  });
  view.addEventListener("focusin", (e) => {
    const el = bk(e); if (!el) return;
    // Roving focus: one tab stop per pile, the last book you were on.
    for (const s of el.parentElement!.children) (s as HTMLElement).tabIndex = s === el ? 0 : -1;
    caption(el, true);
  });
  view.addEventListener("focusout", (e) => { const el = bk(e); if (el && !el.matches(":hover")) caption(el, false); });
  view.addEventListener("click", (e) => {
    if ((e.target as Element).closest(".clear")) { q.value = ""; query = ""; draw(); q.focus(); return; }
    const el = bk(e); if (el) open(+el.dataset.p!, bookOf(el));
  });
  // Up and down move through a pile; left and right hop to the neighbouring pile.
  view.addEventListener("keydown", (e) => {
    const el = bk(e); if (!el) return;
    const pile = el.parentElement!, list = [...pile.children] as HTMLElement[], j = list.indexOf(el);
    let to: HTMLElement | undefined;
    if (e.key === "ArrowUp") to = list[j - 1];
    else if (e.key === "ArrowDown") to = list[j + 1];
    else if (e.key === "Home") to = list[0];
    else if (e.key === "End") to = list[list.length - 1];
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const all = $$(".pile", view), pi = all.indexOf(pile as HTMLElement) + (e.key === "ArrowRight" ? 1 : -1);
      const next = all[pi];
      if (next) { const nb = [...next.children] as HTMLElement[]; to = nb[Math.max(0, nb.length - (list.length - j))]; }
    } else return;
    e.preventDefault();
    if (to) { to.focus(); to.scrollIntoView({ block: "nearest" }); }
  });

  // ---------- the drawer ----------
  let cur: { p: number; j: number; b: Book } | null = null;
  const markOpen = (id: string) => {
    for (const el of $$(".bk.open", view)) el.classList.remove("open");
    view.querySelector(`.bk[data-id="${CSS.escape(id)}"]`)?.classList.add("open");
  };
  function fill() {
    const { p, j, b } = cur!, pile = piles[p]!;
    const rgb = rgbOf(b);
    dlg.dataset.id = b.id; // so a colour sampled later paints the drawer too
    dlg.style.setProperty("--c", hex(rgb));
    d.from.innerHTML = `<b>${esc(pile.name)}</b>${pile.parts > 1 ? ` · pile ${pile.part} of ${pile.parts}` : ""}`;
    d.pos.textContent = `${j + 1} / ${pile.books.length}`;
    d.prev.disabled = j === 0;
    d.next.disabled = j === pile.books.length - 1;
    d.cover.innerHTML = b.cover ? `<img src="${esc(b.cover)}" alt="Cover of ${esc(b.title)}">` : "";
    d.title.textContent = b.title;
    d.by.textContent = b.author;
    d.stars.innerHTML = b.rating ? stars(b.rating) : "";
    d.stars.hidden = !b.rating;
    d.actions.innerHTML = links(b).join("");
    d.facts.innerHTML = facts(b).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    d.shelves.innerHTML = (b.shelves || []).map((s) => `<span>${esc(human(s))}</span>`).join("");
    d.review.className = b.review ? "review" : "review none";
    d.review.innerHTML = b.review
      ? `<h3>${who ? `${esc(who)}’s review` : "Review"}</h3>${paragraphs(b.review)}`
      : `<p>${who ? `${esc(who)} hasn’t written a review of this one.` : "No review of this one."}</p>`;
    d.scroll.scrollTop = 0;
    markOpen(b.id);
    history.replaceState(null, "", `#book-${b.id}`);
  }
  function open(p: number, b: Book) {
    const j = piles[p]!.books.indexOf(b);
    cur = { p, j, b };
    fill();
    if (!dlg.open) {
      dlg.showModal();
      d.scroll.scrollTop = 0;
      requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.add("in")));
    }
  }
  let closing = false;
  function close() {
    if (!dlg.open || closing) return;
    closing = true;
    dlg.classList.remove("in");
    if (reduced()) dlg.close(); else setTimeout(() => dlg.close(), 380);
  }
  // After any close, ours or the browser's: clear the hash and put focus back on the book.
  dlg.addEventListener("close", () => {
    closing = false;
    dlg.classList.remove("in");
    history.replaceState(null, "", location.pathname + location.search);
    const id = cur?.b.id;
    for (const x of $$(".bk.open", view)) x.classList.remove("open");
    const el = id ? view.querySelector<HTMLElement>(`.bk[data-id="${CSS.escape(id)}"]`) : null;
    if (el) {
      for (const s of el.parentElement!.children) (s as HTMLElement).tabIndex = s === el ? 0 : -1;
      el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" });
    }
  });
  function step(dir: number) {
    if (!cur) return;
    const pile = piles[cur.p]!, j = cur.j + dir;
    if (j < 0 || j >= pile.books.length) return;
    cur = { p: cur.p, j, b: pile.books[j]! };
    if (reduced()) { fill(); return; }
    dlg.classList.add("swap");
    setTimeout(() => { fill(); dlg.classList.remove("swap"); }, 130);
  }
  $(".close", dlg).addEventListener("click", close);
  d.prev.addEventListener("click", () => step(-1));
  d.next.addEventListener("click", () => step(1));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  // The scrim is the dialog's backdrop: a click outside the drawer's box closes it.
  dlg.addEventListener("click", (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close();
  });
  dlg.addEventListener("keydown", (e) => {
    if ((e.target as Element).closest("a")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  });

  // ---------- controls ----------
  for (const btn of $$<HTMLButtonElement>("[data-group]")) btn.addEventListener("click", () => {
    const g = btn.dataset.group as GroupBy;
    if (groupBy === g) return;
    groupBy = g;
    for (const x of $$("[data-group]")) x.setAttribute("aria-pressed", String(x === btn));
    draw(true);
  });
  q.addEventListener("input", () => { query = q.value; draw(); });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape" && q.value) { e.preventDefault(); q.value = ""; query = ""; draw(); } });
  addEventListener("keydown", (e) => {
    if (e.key === "/" && !dlg.open && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) { e.preventDefault(); q.focus(); }
  }, { signal: pageSignal() });

  // ---------- go ----------
  draw(true);
  sampleAll(books, root);
  function fromHash() {
    const m = /^#book-([^/?#]+)$/.exec(location.hash); if (!m) return;
    const b = byId.get(m[1]!); if (!b) return;
    let p = piles.findIndex((x) => x.books.includes(b));
    if (p < 0) { query = ""; q.value = ""; draw(); p = piles.findIndex((x) => x.books.includes(b)); }
    if (p < 0) return;
    view.querySelector(`.bk[data-id="${CSS.escape(b.id)}"]`)?.scrollIntoView({ block: "center" });
    open(p, b);
  }
  fromHash();
  addEventListener("hashchange", fromHash, { signal: pageSignal() });
  return books.length;
};
