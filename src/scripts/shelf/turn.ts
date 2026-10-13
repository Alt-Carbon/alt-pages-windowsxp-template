// Bookshelf style "turn" (ported from protos/bookshelf-c-turn.html). Each row is a dark stage of 3D
// books standing spine-out, one turned to show its cover. Hover or focus turns a book and widens its
// slot; a click opens the details inline under the row. Rows: Favourites (five stars), Reading now,
// then each year. Deep links: #book-<id>.
import "../../styles/shelf/turn.css";
import { type Book, type Shelf, type Style, NOW, esc, facts, groups, hash, hex, links, n, pageSignal, paragraphs, reduced, rgbOf, sampleAll, short, stars, surname, textOn } from "./shared";

type Row = { key: string; label: string; books: Book[] };
type Spring = { a: number; v: number; to: number; W: number; D: number; bx: HTMLElement };

const LIMIT = 20, TURN = 16, PERSP = 1100;
const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)];
const ARROW = (d: number) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d < 0 ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"}"/></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const phone = () => matchMedia("(max-width: 640px)").matches;
// The drawn cover for a book without an image: title and author on the cloth colour.
const textCover = (b: Book) => `<span class="tc"><b>${esc(short(b.title))}</b><i>${esc(b.author)}</i></span>`;
const hashId = () => decodeURIComponent(location.hash.replace(/^#book-/, "")) || "";

// Window-level listeners, replaced on each render so a re-render never doubles them.
let onKey: ((e: KeyboardEvent) => void) | null = null;
let onResize: (() => void) | null = null;
let onHash: (() => void) | null = null;

export const render: Style = (shelf, root) => {
  const byId = new Map(shelf.books.map((b) => [b.id, b]));
  const key = (b: Book) => hash(b.title + b.author);
  const owner = shelf.owner ? `${esc(shelf.owner)}’s review` : "Review";

  let query = "";
  const expanded = new Set<string>();      // rows showing every book
  const turnedIn = new Map<string, string>(); // row key -> id of the book facing out
  let openAt: { key: string; id: string } | null = null;
  let SCALE = 1;
  let ROWS: Row[] = [];

  root.innerHTML = `<div class="controls" role="search"><label class="search"><span class="vh">Find a title or author</span>`
    + `<input type="search" placeholder="Find a title or author" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label></div>`
    + `<div class="rows"></div>`;
  const rowsEl = $(".rows", root)!, q = $<HTMLInputElement>(".search input", root)!, controls = $(".controls", root)!;

  // ---------- rows ----------
  const filtered = () => {
    const s = query.trim().toLowerCase();
    return s ? shelf.books.filter((b) => b.title.toLowerCase().includes(s) || b.author.toLowerCase().includes(s)) : shelf.books;
  };
  function rows(list: Book[]): Row[] {
    const out: Row[] = [];
    const fav = list.filter((b) => b.rating === 5);
    if (fav.length) out.push({ key: "fav", label: "Favourites", books: fav });
    for (const [label, bs] of groups(list)) out.push({ key: label === NOW ? "now" : `y-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, label, books: bs });
    return out;
  }

  // Geometry. A book is a box W wide (the cover), H tall and D deep (the spine).
  const dims = (b: Book) => {
    const k = key(b), H = Math.round((212 + (k % 46)) * SCALE);
    return { H, W: Math.round(H * 0.665), D: Math.round(Math.max(SCALE < 1 ? 18 : 22, Math.min(54, (b.pages || 280) / 10) * SCALE)) };
  };
  const projected = (W: number, D: number, a: number, pull = 0) => {
    const r = (a * Math.PI) / 180;
    return (W * Math.abs(Math.cos(r)) + D * Math.abs(Math.sin(r))) * PERSP / (PERSP - pull);
  };
  // Keep the face nearest the viewer at the slot's plane, so the book doesn't swell as it turns.
  function boxTransform(W: number, D: number, a: number, pull = 0) {
    const r = (a * Math.PI) / 180;
    const near = (W / 2) * Math.abs(Math.sin(r)) + (D / 2) * Math.abs(Math.cos(r));
    return `translateZ(${(pull - near).toFixed(2)}px) rotateY(${a.toFixed(2)}deg)`;
  }
  function bookHTML(b: Book, row: Row, on: boolean) {
    const { H, W, D } = dims(b), k = key(b), rgb = rgbOf(b);
    const style = `--h:${H}px;--w:${W}px;--d:${D}px;--c:${hex(rgb)};--t:${textOn(rgb)};width:${(on ? projected(W, D, TURN) : D).toFixed(2)}px`;
    const front = b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" decoding="async" draggable="false">` : textCover(b);
    return `<button class="bk${on ? " on" : ""}" type="button" data-id="${esc(b.id)}" data-w="${W}" data-d="${D}" tabindex="${on ? 0 : -1}"`
      + ` aria-label="${esc(`${b.title}, ${b.author}`)}" aria-expanded="false" aria-controls="dp-${row.key}" style="${style}">`
      + `<span class="pp" aria-hidden="true"><span class="bx" style="transform:${boxTransform(W, D, on ? TURN : 90)}">`
      + `<span class="fc bk-bk"></span><span class="fc pg"></span>`
      + `<span class="fc sp f${k % 2}${k % 4 === 1 ? " band" : ""}"><span class="ti">${esc(short(b.title))}</span><span class="au">${esc(surname(b.author))}</span></span>`
      + `<span class="fc fr">${front}</span></span></span></button>`;
  }
  // Which book faces out by default: the best-rated of the first few, ties going to the one nearest third place.
  function defaultTurn(list: Book[]) {
    const head = list.slice(0, 8);
    const score = (b: Book, j: number) => (b.rating || 0) * 10 - Math.abs(j - 2) + (b.cover ? 0 : -50);
    let best = head[0]!, bs = score(best, 0);
    head.forEach((b, j) => { const s = score(b, j); if (s > bs) { best = b; bs = s; } });
    return best;
  }
  function stageHTML(row: Row) {
    const all = row.books, open = expanded.has(row.key) || !!query;
    const shown = open ? all : all.slice(0, LIMIT);
    let tid = turnedIn.get(row.key);
    if (!shown.some((b) => b.id === tid)) { tid = defaultTurn(shown).id; turnedIn.set(row.key, tid); }
    const count = all.length, word = count === 1 ? "book" : "books";
    const more = all.length > LIMIT && !query
      ? `<button class="more" type="button" data-more="${row.key}">${open ? "Show fewer" : `Show all <b>&nbsp;${count}&nbsp;</b>`}</button>` : "";
    return `<section class="stage" data-key="${row.key}" aria-labelledby="h-${row.key}">`
      + `<div class="rh"><span class="n">${count} ${word}</span><h2 id="h-${row.key}"><span>${esc(row.label)}</span></h2>`
      + `<span class="nav"><button type="button" data-scroll="-1" aria-label="Scroll ${esc(row.label)} back">${ARROW(-1)}</button><button type="button" data-scroll="1" aria-label="Scroll ${esc(row.label)} on">${ARROW(1)}</button></span></div>`
      + `<div class="shelfwrap"><div class="shelf" role="group" aria-label="${esc(row.label)}, ${count} ${word}">${shown.map((b) => bookHTML(b, row, b.id === tid)).join("")}${more}</div>`
      + `<p class="cap" aria-hidden="true"></p></div>`
      + `<div class="dp" id="dp-${row.key}" role="region" aria-label="Book details" inert><div></div></div></section>`;
  }

  const stageOf = (k: string) => $(`.stage[data-key="${k}"]`, rowsEl);
  const stageFor = (el: Element) => el.closest<HTMLElement>(".stage")!;
  const rowOf = (el: Element) => ROWS.find((r) => r.key === stageFor(el).dataset.key)!;
  const bookOf = (el: HTMLElement) => byId.get(el.dataset.id!)!;

  function draw() {
    SCALE = phone() ? 0.72 : 1;
    const list = filtered();
    ROWS = rows(list);
    if (openAt && !ROWS.some((r) => r.key === openAt!.key && r.books.some((b) => b.id === openAt!.id))) openAt = null;
    rowsEl.innerHTML = list.length ? ROWS.map(stageHTML).join("") : `<p class="empty">No books match “${esc(query)}”.</p>`;
    for (const st of $$(".stage", rowsEl)) { caption(st); navState(st); }
    if (openAt) { const st = stageOf(openAt.key), el = st && $(`.bk[data-id="${openAt.id}"]`, st); if (el) openPanel(el, { instant: true }); }
  }
  function caption(st: HTMLElement) {
    const el = $(".bk.on", st), cap = $(".cap", st); if (!el || !cap) return;
    const b = bookOf(el);
    cap.innerHTML = `<b>${esc(short(b.title))}</b> · ${esc(b.author)}${b.rating ? `<span class="st"> ${"★".repeat(b.rating)}</span>` : ""}`;
  }

  // ---------- the turn: a small spring per book drives both its angle and its slot width ----------
  const springs = new Map<HTMLElement, Spring>();
  const moving = new Set<HTMLElement>();
  let raf = 0, last = 0;
  function spring(el: HTMLElement) {
    let s = springs.get(el);
    if (!s) { const on = el.classList.contains("on"); s = { a: on ? TURN : 90, v: 0, to: on ? TURN : 90, W: +el.dataset.w!, D: +el.dataset.d!, bx: $(".bx", el)! }; springs.set(el, s); }
    return s;
  }
  function pose(el: HTMLElement, s: Spring) {
    const t = Math.min(1, Math.max(0, (90 - s.a) / (90 - TURN))), pull = 10 * t;
    el.style.width = `${projected(s.W, s.D, s.a, pull).toFixed(2)}px`;
    s.bx.style.transform = boxTransform(s.W, s.D, s.a, pull);
  }
  function tick(now: number) {
    const dt = Math.min(1 / 30, (now - last) / 1000 || 1 / 60); last = now;
    for (const [el, s] of springs) {
      if (!el.isConnected) { springs.delete(el); continue; }
      if (s.a === s.to && s.v === 0) continue;
      const f = -190 * (s.a - s.to) - 21 * s.v;
      s.v += f * dt; s.a += s.v * dt;
      if (Math.abs(s.a - s.to) < 0.04 && Math.abs(s.v) < 0.4) { s.a = s.to; s.v = 0; }
      pose(el, s);
    }
    const busy = [...springs.values()].some((s) => s.a !== s.to || s.v !== 0);
    raf = busy ? requestAnimationFrame(tick) : 0;
    if (!busy) { for (const st of moving) navState(st); moving.clear(); }
  }
  function setTarget(el: HTMLElement, to: number) {
    const s = spring(el); s.to = to;
    if (reduced()) { s.a = to; s.v = 0; pose(el, s); navState(stageFor(el)); return; }
    moving.add(stageFor(el));
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function turn(el: HTMLElement | null) {
    if (!el || el.classList.contains("on")) return;
    const st = stageFor(el), prev = $(".bk.on", st);
    spring(el); if (prev) spring(prev); // capture current poses before the classes change
    if (prev) { prev.classList.remove("on"); prev.tabIndex = -1; setTarget(prev, 90); }
    el.classList.add("on"); el.tabIndex = 0; setTarget(el, TURN);
    turnedIn.set(st.dataset.key!, el.dataset.id!);
    caption(st);
  }
  // Keep a book in view as its slot widens: estimate where it will sit once settled.
  function reveal(el: HTMLElement) {
    const shelf = el.parentElement!;
    const s = spring(el), prev = [...springs].find(([e, p]) => e !== el && e.parentElement === shelf && p.to === 90 && p.a !== 90);
    let left = el.offsetLeft;
    if (prev && prev[0].offsetLeft < el.offsetLeft) left -= prev[0].offsetWidth - prev[1].D;
    const w = projected(s.W, s.D, TURN, 10), pad = SCALE < 1 ? 28 : 56;
    const target = Math.min(Math.max(shelf.scrollLeft, left + w + pad - shelf.clientWidth), left - pad);
    if (Math.abs(target - shelf.scrollLeft) > 1) shelf.scrollTo({ left: target, behavior: reduced() ? "auto" : "smooth" });
  }

  // ---------- details panel ----------
  function panelHTML(b: Book, row: Row, pos: number, count: number) {
    const review = b.review
      ? `<div class="rv"><h4>${owner}</h4><div class="rv-t">${paragraphs(b.review)}</div><button class="rv-more" type="button" hidden>Read full review</button></div>`
      : `<p class="rv none">No written review for this one.</p>`;
    return `<div class="dp-in swap">`
      + `<div class="dp-cv" data-id="${esc(b.id)}" style="--c:${hex(rgbOf(b))};--t:${textOn(rgbOf(b))}">${b.cover ? `<img src="${esc(b.cover)}" alt="Cover of ${esc(b.title)}">` : textCover(b)}</div>`
      + `<div class="dp-hd"><p class="kick">${b.now ? NOW : esc(row.label)} · ${pos} of ${count}</p><h3 id="t-${row.key}">${esc(b.title)}</h3><p class="by">${esc(b.author)}</p>${b.rating ? stars(b.rating) : ""}</div>`
      + `<div class="dp-bd"><dl class="facts">${facts(b).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${review}`
      + `<div class="acts">${links(b).join("")}</div></div>`
      + `<div class="dp-tools"><button type="button" data-step="-1" aria-label="Previous book"${pos === 1 ? " disabled" : ""}>${ARROW(-1)}</button>`
      + `<button type="button" data-step="1" aria-label="Next book"${pos === count ? " disabled" : ""}>${ARROW(1)}</button>`
      + `<button type="button" data-close aria-label="Close details">${CROSS}</button></div></div>`;
  }
  function fillPanel(el: HTMLElement) {
    const st = stageFor(el), row = rowOf(el), dp = $(".dp", st)!;
    const bks = $$(".bk", st), b = bookOf(el);
    dp.firstElementChild!.innerHTML = panelHTML(b, row, bks.indexOf(el) + 1, bks.length);
    dp.setAttribute("aria-labelledby", `t-${row.key}`);
    for (const x of bks) x.setAttribute("aria-expanded", String(x === el));
    openAt = { key: row.key, id: b.id };
    history.replaceState(null, "", `#book-${b.id}`);
    const rv = $(".rv", dp);
    if (rv && !rv.classList.contains("none")) {
      const t = $(".rv-t", rv)!;
      if (t.scrollHeight > t.clientHeight + 8) { rv.classList.add("clip"); $(".rv-more", rv)!.hidden = false; }
    }
  }
  function openPanel(el: HTMLElement, { instant = false } = {}) {
    const st = stageFor(el), dp = $(".dp", st)!;
    const was = $(".stage .dp.open", rowsEl);
    if (was && was !== dp) closePanel(stageFor(was), { refocus: false });
    fillPanel(el);
    dp.inert = false;
    if (instant) { dp.style.transition = "none"; dp.classList.add("open"); void dp.offsetHeight; dp.style.transition = ""; return; }
    if (!dp.classList.contains("open")) {
      dp.classList.add("open");
      // Once it has grown, make sure the panel's top is on screen.
      setTimeout(() => {
        const r = dp.getBoundingClientRect(), vh = innerHeight;
        const bar = controls.getBoundingClientRect().bottom;
        const shelfTop = $(".shelfwrap", st)!.getBoundingClientRect().top - bar - 8;
        const need = Math.min(r.bottom, r.top + 360) - vh + 16;
        if (need > 0) scrollBy({ top: Math.min(need, shelfTop), behavior: reduced() ? "auto" : "smooth" });
      }, reduced() ? 0 : 260);
    }
  }
  function closePanel(st: HTMLElement, { refocus = true } = {}) {
    const dp = $(".dp", st)!; if (!dp.classList.contains("open")) return;
    const el = $('.bk[aria-expanded="true"]', st);
    dp.classList.remove("open"); dp.inert = true;
    for (const x of $$(".bk", st)) x.setAttribute("aria-expanded", "false");
    if (openAt?.key === st.dataset.key) { openAt = null; if (/^#book-/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search); }
    if (refocus && el) el.focus({ preventScroll: true });
  }
  function step(st: HTMLElement, d: number) {
    const bks = $$(".bk", st), cur = $(".bk.on", st) || bks[0];
    const nb = bks[Math.max(0, Math.min(bks.length - 1, bks.indexOf(cur!) + d))];
    if (!nb || nb === cur) return nb;
    turn(nb); reveal(nb);
    if ($(".dp", st)!.classList.contains("open")) fillPanel(nb);
    return nb;
  }
  // Prev / next buttons dim at the ends of a row.
  function navState(st: HTMLElement) {
    const sh = $(".shelf", st); if (!sh) return;
    const [p, nx] = $$<HTMLButtonElement>("[data-scroll]", st);
    p!.disabled = sh.scrollLeft < 4; nx!.disabled = sh.scrollLeft + sh.clientWidth > sh.scrollWidth - 4;
    $(".nav", st)!.style.visibility = sh.scrollWidth > sh.clientWidth + 4 ? "" : "hidden";
  }
  // A deep link (#book-<id>): the first row holding the book, shown in full if the book is past the fold.
  function goTo(id: string) {
    const b = byId.get(id); if (!b) return false;
    if (query) { query = ""; q.value = ""; }
    const row = rows(shelf.books).find((r) => r.books.some((x) => x.id === id)); if (!row) return false;
    if (row.books.findIndex((x) => x.id === id) >= LIMIT) expanded.add(row.key);
    turnedIn.set(row.key, id);
    openAt = { key: row.key, id };
    draw();
    const st = stageOf(row.key), el = st && $(`.bk[data-id="${id}"]`, st); if (!el) return false;
    reveal(el);
    st.scrollIntoView({ block: "start", behavior: "auto" });
    scrollBy({ top: -(controls.offsetHeight + 8) });
    el.focus({ preventScroll: true });
    return true;
  }

  // ---------- pointer, touch and keyboard ----------
  let lastPointer = "mouse", hoverT = 0;
  rowsEl.addEventListener("pointerdown", (e) => { lastPointer = e.pointerType; }, true);
  rowsEl.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const el = (e.target as Element).closest<HTMLElement>(".bk");
    clearTimeout(hoverT);
    if (el && !el.classList.contains("on")) hoverT = window.setTimeout(() => turn(el), 70);
  });
  rowsEl.addEventListener("pointerleave", () => clearTimeout(hoverT));
  // Keyboard focus turns the book; a mouse or touch focus waits for hover or the first tap.
  rowsEl.addEventListener("focusin", (e) => {
    const el = (e.target as Element).closest?.<HTMLElement>(".bk");
    if (el && el.matches(":focus-visible")) { turn(el); reveal(el); }
  });
  rowsEl.addEventListener("click", (e) => {
    const t = e.target as Element;
    const sc = t.closest<HTMLElement>("[data-scroll]");
    if (sc) { const sh = $(".shelf", stageFor(sc))!; sh.scrollBy({ left: +sc.dataset.scroll! * sh.clientWidth * 0.75, behavior: reduced() ? "auto" : "smooth" }); return; }
    const mo = t.closest<HTMLElement>("[data-more]");
    if (mo) {
      const k = mo.dataset.more!; expanded.has(k) ? expanded.delete(k) : expanded.add(k);
      const st = stageOf(k)!, row = ROWS.find((r) => r.key === k)!, sl = $(".shelf", st)!.scrollLeft;
      const wasOpen = openAt?.key === k ? openAt.id : null;
      st.outerHTML = stageHTML(row);
      const ns = stageOf(k)!; caption(ns); navState(ns); $(".shelf", ns)!.scrollLeft = sl;
      if (wasOpen) { const el = $(`.bk[data-id="${wasOpen}"]`, ns); el ? openPanel(el, { instant: true }) : (openAt = null); }
      $("[data-more]", ns)?.focus({ preventScroll: true });
      return;
    }
    const st = t.closest<HTMLElement>(".stage"); if (!st) return;
    if (t.closest("[data-close]")) { closePanel(st); return; }
    const sp = t.closest<HTMLElement>("[data-step]");
    if (sp) {
      // The panel is redrawn for the next book, so put focus back on the same button (or its twin at the end).
      const d = +sp.dataset.step!; step(st, d);
      const again = $<HTMLButtonElement>(`[data-step="${d}"]`, st), other = $<HTMLButtonElement>(`[data-step="${-d}"]`, st);
      (again && !again.disabled ? again : other)?.focus({ preventScroll: true });
      return;
    }
    const more = t.closest<HTMLElement>(".rv-more");
    if (more) {
      const rv = more.closest(".rv")!, tx = $(".rv-t", rv)!;
      tx.style.setProperty("--mh", `${tx.scrollHeight + 4}px`); rv.classList.remove("clip"); more.hidden = true;
      return;
    }
    const el = t.closest<HTMLElement>(".bk"); if (!el) return;
    const keyboard = e.detail === 0;
    // On touch the first tap turns the book to face you; the second opens it.
    if (!keyboard && lastPointer === "touch" && !el.classList.contains("on")) { turn(el); reveal(el); return; }
    turn(el);
    if (el.getAttribute("aria-expanded") === "true") closePanel(st, { refocus: false });
    else openPanel(el);
  });
  rowsEl.addEventListener("keydown", (e) => {
    const t = e.target as Element, el = t.closest<HTMLElement>(".bk"), st = t.closest<HTMLElement>(".stage");
    if (e.key === "Escape" && st && $(".dp", st)!.classList.contains("open")) { e.preventDefault(); closePanel(st); return; }
    if (!el || !st) return;
    const bks = $$(".bk", st), i = bks.indexOf(el);
    const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bks.length - 1 } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const nb = bks[Math.max(0, Math.min(bks.length - 1, to))]; if (!nb || nb === el) return;
    nb.focus({ preventScroll: true }); turn(nb); reveal(nb);
    if ($(".dp", st)!.classList.contains("open")) fillPanel(nb);
  });
  // A cover that fails to load (Goodreads' placeholder, a dead link) gives way to the drawn text cover.
  rowsEl.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const host = img.closest<HTMLElement>(".bk, .dp-cv"), b = host && byId.get(host.dataset.id!);
    if (b && img.parentElement?.matches(".fr, .dp-cv")) img.outerHTML = textCover(b);
  }, true);
  rowsEl.addEventListener("scroll", (e) => { const t = e.target as HTMLElement; if (t.classList?.contains("shelf")) navState(stageFor(t)); }, true);

  // ---------- search, and the window-level listeners ----------
  q.addEventListener("input", () => { query = q.value; draw(); });
  if (onKey) removeEventListener("keydown", onKey);
  onKey = (e) => {
    if (!root.isConnected) return;
    if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) { e.preventDefault(); q.focus(); }
    if (e.key === "Escape" && document.activeElement === q && query) { q.value = ""; query = ""; draw(); return; }
    // Esc with focus outside the rows (after "Read full review" hid its button, say) still closes the open panel.
    if (e.key === "Escape" && openAt && !rowsEl.contains(document.activeElement)) { const st = stageOf(openAt.key); if (st) closePanel(st); }
  };
  addEventListener("keydown", onKey, { signal: pageSignal() });
  if (onResize) removeEventListener("resize", onResize);
  onResize = () => { if (!root.isConnected) return; const s = phone() ? 0.72 : 1; if (s !== SCALE) draw(); else $$(".stage", rowsEl).forEach(navState); };
  addEventListener("resize", onResize, { signal: pageSignal() });
  if (onHash) removeEventListener("hashchange", onHash);
  onHash = () => { const id = hashId(); if (id && id !== openAt?.id) goTo(id); };
  addEventListener("hashchange", onHash, { signal: pageSignal() });

  draw();
  const id = hashId();
  if (id) goTo(id);
  sampleAll(shelf.books, root);
  return shelf.books.length;
};
