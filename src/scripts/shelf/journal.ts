// Bookshelf style "journal" (prototype F · Journal). A reading journal rather than a shelf: the books
// being read as a row of covers, then one section per year with the year as a big numeral, a strip of
// the months (one dot per book finished, a tooltip naming them), a ledger of the year's numbers, and
// the entries with the review front and centre: five-star reviews open with their first sentence as a
// pull quote, long reviews cut to an excerpt that "Read more" expands in place. A sticky bar holds the
// filter chips, the year links and the search (hits are marked); ?filter=, ?q= and #book-<id> are the
// URL. Everything renders once; filtering and search only hide, show and re-mark.
import "../../styles/shelf/journal.css";
import { type Book, type Shelf, type Style, day, esc, excerpt, groups, links, monthYear, n, pageSignal, paragraphs, reduced, short, stars } from "./shared";

type Group = { key: string; books: Book[] };
type Entry = { b: Book; pull: string; body: string; flat: string; long: boolean; mins: number; hay: string };

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const mon = (iso: string) => monthYear(iso).split(" ")[0]!;
const monthOf = (iso: string) => +iso.slice(5, 7) - 1;
const THIS_YEAR = String(new Date().getFullYear());
// Dates this year drop the year ("7 Sep"); older ones keep it.
const dayNoYear = (iso: string) => (iso.slice(0, 4) === THIS_YEAR ? day(iso).replace(/ \d{4}$/, "") : day(iso));
const CUT = 240;

// A five-star review opens with its first sentence set as a pull quote, when that sentence is a sensible length.
const ABBR = /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|eg|Eg|ie|etc|e\.g|i\.e|U\.S|No)$/;
function firstSentence(s: string): string | null {
  const re = /[.!?…]["”’)]*(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length, head = s.slice(0, m.index);
    if (end < 28) continue;
    if (ABBR.test(head) || /\n/.test(s.slice(0, end))) return null;
    return end <= 170 ? s.slice(0, end) : null;
  }
  return null;
}

// ---------- text ----------
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Wrap the search hits in <mark>, in HTML that is already escaped: only the text between tags is touched,
// and the query is escaped the same way so it matches the entities.
function markHTML(html: string, q: string) {
  if (!q) return html;
  const re = new RegExp(`(${reEsc(esc(q))})`, "gi");
  return html.split(/(<[^>]+>)/).map((p, k) => (k % 2 ? p : p.split(re).map((s, j) => (j % 2 ? `<mark>${s}</mark>` : s)).join(""))).join("");
}
const hl = (raw: string, q: string) => markHTML(esc(raw), q);
// The excerpt is the opening of the review, unless the search hits further in: then it is the passage around the hit.
function excerptOf(e: Entry, q: string) {
  const f = e.flat;
  if (q) {
    const at = f.toLowerCase().indexOf(q);
    if (at > CUT - q.length - 20) {
      let s = Math.max(0, at - 90);
      if (s > 0) s = f.indexOf(" ", s) + 1;
      let end = Math.min(f.length, at + q.length + 150);
      if (end < f.length) { const sp = f.lastIndexOf(" ", end); if (sp > at + q.length) end = sp; }
      return (s > 0 ? "…" : "") + f.slice(s, end).replace(/[\s,;:—–\-]+$/, "") + (end < f.length ? "…" : "");
    }
  }
  return excerpt(f, CUT);
}
// The title in the display face, a subtitle after ":" or "(" in the muted colour.
function titleHTML(t: string, q: string) {
  const m = /^(.+?)(\s*(?::\s|\().*)$/.exec(t);
  return m ? `${hl(m[1]!, q)}<span class="s">${hl(m[2]!, q)}</span>` : hl(t, q);
}
const cover = (b: Book, big = false) =>
  `<span class="cv" data-id="${b.id}" aria-hidden="true">${b.cover ? `<img src="${esc(big ? b.cover : b.cover.replace(/\._S[XY]\d+_\./, "._SX160_."))}" alt="" loading="lazy" decoding="async">` : `<span class="ini">${esc(b.title[0] || "")}</span>`}</span>`;
const chev = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

// One render at a time: a re-render drops the previous listeners and observers.
let ctrl: AbortController | null = null;

export const render: Style = (shelf: Shelf, root: HTMLElement) => {
  ctrl?.abort();
  ctrl = new AbortController();
  pageSignal().addEventListener("abort", () => ctrl?.abort(), { once: true });
  const { signal } = ctrl;
  document.querySelectorAll(".shelf-journal-tip").forEach((t) => t.remove());

  const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = root) => r.querySelector<T>(s);
  const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = root) => [...r.querySelectorAll<T>(s)];

  // ---------- data ----------
  const entries = new Map<string, Entry>();
  for (const b of shelf.books) {
    const rv = (b.review || "").trim();
    let pull = "", body = rv;
    if (rv && b.rating === 5) {
      const f = firstSentence(rv);
      if (f && rv.length - f.length > 40) { pull = f; body = rv.slice(f.length).trim(); }
    }
    const flat = body.replace(/\s*\n\s*/g, " ");
    entries.set(b.id, { b, pull, body, flat, long: flat.length > CUT + 70, mins: rv ? Math.max(1, Math.round(rv.split(/\s+/).length / 230)) : 0, hay: `${b.title}\n${b.author}\n${rv}`.toLowerCase() });
  }
  const entry = (id: string) => entries.get(id)!;
  const reading = [...shelf.reading].sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
  // Years newest first, the books without a finish date last (newest added first, as shared sorts them).
  const years: Group[] = groups(shelf.read).map(([k, books]) => ({ key: k === "Not dated" ? "undated" : k, books }));
  const inMonth = (g: Group, m: number) => g.books.filter((b) => b.readAt && monthOf(b.readAt) === m);
  const maxPerMonth = Math.max(1, ...years.filter((g) => g.key !== "undated").flatMap((g) => MONTHS_LONG.map((_, m) => inMonth(g, m).length)));
  root.style.setProperty("--max", String(maxPerMonth));
  const owner = shelf.owner ? `${esc(shelf.owner)}’s review` : "Review";

  // ---------- markup ----------
  function ledger(g: Group) {
    const bs = g.books, rated = bs.filter((b) => b.rating), withP = bs.filter((b) => b.pages);
    const pages = withP.reduce((s, b) => s + b.pages!, 0);
    const longest = withP.reduce<Book | null>((a, b) => (b.pages! > (a?.pages || 0) ? b : a), null);
    const rows: [string, string][] = [["Books", n(bs.length)]];
    if (pages) rows.push(["Pages", n(pages)]);
    if (rated.length) rows.push(["Avg rating", `${(rated.reduce((s, b) => s + b.rating!, 0) / rated.length).toFixed(1)} <span class="st" aria-hidden="true">★</span>`]);
    if (longest) rows.push(["Longest", `<a href="#book-${longest.id}" title="${esc(longest.title)}">${esc(short(longest.title))}</a><small>${n(longest.pages!)} pp</small>`]);
    return `<dl class="ledger">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  }
  // The month strip is a chart: screen readers get one summary line; pointer users get a tooltip per
  // month and a click to jump there. Keyboard users have the year menu and the entries themselves (one
  // button per month was 12 tab stops a year, each narrower than a 24px target).
  function monthStrip(g: Group) {
    const counts = MONTHS_LONG.map((name, k) => [name, inMonth(g, k).length] as const);
    const read = counts.filter(([, c]) => c).map(([name, c]) => `${name} ${c}`).join(", ");
    return `<div class="months" role="img" aria-label="${esc(`Books finished each month in ${g.key}: ${read || "none dated"}`)}">${MONTHS_LONG.map((name, k) => {
      const bs = inMonth(g, k).reverse();
      return `<span class="mo" data-y="${g.key}" data-m="${k}" data-n="${bs.length}">`
        + `<span class="dots">${bs.map((b) => `<i class="dot" data-book="${b.id}"></i>`).join("")}</span><span class="l">${name[0]}</span></span>`;
    }).join("")}</div>`;
  }
  function entryHTML(b: Book, k: number, undated: boolean) {
    const e = entry(b.id);
    // Dated entries carry the finish date as a small line above the title; undated ones show "Added" in the meta.
    const date = undated ? "" : `<a class="d" href="#book-${b.id}" aria-label="Link to this entry, finished ${day(b.readAt)}"><b>${+b.readAt!.slice(8, 10)}</b><span>${mon(b.readAt!)}</span></a>`;
    const meta = [
      b.rating ? stars(b.rating) : "",
      undated ? (b.addedAt ? `<span>Added ${day(b.addedAt)}</span>` : "") : `<span class="md">${dayNoYear(b.readAt!)}</span>`,
      b.pages ? `<span>${n(b.pages)} pages</span>` : "",
    ].filter(Boolean).join("");
    const acts = (b.review && e.long
      ? `<button class="expand" type="button" aria-expanded="false" aria-controls="jr-rv-${b.id}"><span class="lb">Read more</span>${e.mins >= 2 ? `<span class="mins">${e.mins} min</span>` : ""}${chev}</button>`
      : "") + `<span class="links">${links(b).join("")}</span>`;
    return `<article class="e${k ? "" : " first"}" id="book-${b.id}" data-id="${b.id}"${b.readAt ? ` data-m="${b.readAt.slice(0, 7)}"` : ""} aria-labelledby="jr-t-${b.id}">${date}${cover(b)}`
      + `<div class="hd"><h3 class="t" id="jr-t-${b.id}"></h3><p class="by"></p>${meta ? `<p class="meta">${meta}</p>` : ""}</div>`
      + (e.pull ? `<blockquote class="pq"></blockquote>` : "")
      + (b.review ? `<span class="vh">${owner}</span><div class="rv" id="jr-rv-${b.id}"></div>` : "")
      + `<div class="acts">${acts}</div></article>`;
  }
  function section(g: Group) {
    const undated = g.key === "undated";
    const head = undated
      ? `<h2 class="num word" id="jr-h-${g.key}">Undated</h2><p class="note">Read, but the finish date was never recorded. Newest added first.</p>`
      : `<h2 class="num" id="jr-h-${g.key}">${g.key}</h2>`;
    return `<section class="yr" id="jr-y-${g.key}" data-key="${g.key}" aria-labelledby="jr-h-${g.key}"><div class="rail">${head}${undated ? "" : monthStrip(g)}${ledger(g)}<p class="shown" aria-hidden="true"></p></div>`
      + `<div class="list">${g.books.map((b, k) => entryHTML(b, k, undated)).join("")}</div></section>`;
  }
  function nowSection() {
    if (!reading.length) return "";
    return `<section class="yr nowband" id="jr-y-now" data-key="now" aria-labelledby="jr-h-now"><div class="nh"><h2 id="jr-h-now">Reading now</h2>`
      + `<p>${plural(reading.length, "book")} on the go, most recently started first</p></div>`
      + `<ul class="nowgrid">${reading.map((b) => `<li id="book-${b.id}" data-id="${b.id}"><a class="nb" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${b.title} by ${b.author}${b.addedAt ? `, started ${day(b.addedAt)}` : ""} (opens Goodreads in a new tab)`)}">${cover(b, true)}`
      + `<span class="nt" aria-hidden="true">${esc(short(b.title))}</span><span class="ns" aria-hidden="true">${b.addedAt ? `Started ${dayNoYear(b.addedAt)}` : "Started"}</span></a></li>`).join("")}</ul></section>`;
  }

  const counts = { all: shelf.books.length, reviewed: shelf.books.filter((b) => b.review).length, five: shelf.books.filter((b) => b.rating === 5).length };
  const chip = (f: string, label: string, c: number) => `<button class="chip" type="button" data-f="${f}" aria-pressed="${f === "all"}">${label}<span>${n(c)}</span></button>`;
  root.innerHTML = `<div class="bar"><div class="strip"><div class="chips" role="group" aria-label="Show">${chip("all", "All", counts.all)}${chip("reviewed", "Reviewed", counts.reviewed)}${chip("five", "5 stars", counts.five)}</div>`
    + `<label class="ymenu"><span class="vh">Jump to year</span><select class="years">`
    + (reading.length ? `<option value="now">Now</option>` : "") + years.map((g) => `<option value="${g.key}">${g.key === "undated" ? "Undated" : g.key}</option>`).join("")
    + `</select></label></div><label class="search"><span class="vh">Search titles, authors and reviews</span><input type="search" placeholder="Search books and reviews" autocomplete="off" spellcheck="false" aria-keyshortcuts="/"><span class="hint" aria-hidden="true"><kbd>/</kbd></span></label></div>`
    + `<p class="vh live" aria-live="polite"></p>`
    + `<div class="view">${nowSection()}${years.map(section).join("")}<div class="empty" hidden><p></p><p><button type="button" class="reset">Show everything</button></p></div></div>`
    + `<p class="fin"><a href="#content" class="totop">Back to top ↑</a></p>`;

  const tip = document.createElement("div");
  tip.className = "shelf-journal-tip";
  tip.setAttribute("aria-hidden", "true");
  document.body.append(tip);

  const view = $(".view")!, bar = $(".bar")!, yearsEl = $<HTMLSelectElement>(".years")!, qEl = $<HTMLInputElement>(".search input")!, hint = $(".hint")!, live = $(".live")!, empty = $(".empty")!;
  const art = (id: string) => $(`#book-${CSS.escape(id)}`);

  // ---------- state, filters and search ----------
  const FILTERS: Record<string, string> = { all: "", reviewed: "reviewed", five: "5-stars" };
  const params = new URLSearchParams(location.search);
  const state = { f: Object.keys(FILTERS).find((k) => FILTERS[k] && FILTERS[k] === params.get("filter")) || "all", q: params.get("q") || "" };
  const norm = (q: string) => q.trim().toLowerCase();
  function match(b: Book, f = state.f, q = norm(state.q)) {
    if (f === "reviewed" && !b.review) return false;
    if (f === "five" && b.rating !== 5) return false;
    return !q || entry(b.id).hay.includes(q);
  }
  // The filter and the search live in the URL, beside whatever else is there (the dev ?shelf= override).
  function syncURL(hash = location.hash) {
    const p = new URLSearchParams(location.search);
    p.delete("filter"); p.delete("q");
    if (FILTERS[state.f]) p.set("filter", FILTERS[state.f]!);
    if (norm(state.q)) p.set("q", state.q.trim());
    const qs = p.toString();
    try { history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${hash}`); } catch {}
  }

  // ---------- review box ----------
  const expanded = new Set<string>();
  function fillReview(e: Entry, q: string) {
    const a = art(e.b.id);
    if (!a || !e.b.review) return;
    const box = $(".rv", a)!, isOpen = expanded.has(e.b.id), open = isOpen || !e.long;
    box.classList.toggle("ex", !open);
    box.innerHTML = open ? markHTML(paragraphs(e.body), q) : `<p>${hl(excerptOf(e, q), q)}</p>`;
    a.classList.toggle("open", isOpen);
    if (!isOpen) a.classList.remove("stuck");
    const btn = $(".expand", a);
    if (btn) {
      btn.setAttribute("aria-expanded", String(isOpen));
      $(".lb", btn)!.textContent = isOpen ? "Show less" : "Read more";
      const mn = $(".mins", btn); if (mn) mn.hidden = isOpen;
    }
  }
  function fillEntry(e: Entry, q: string) {
    const a = art(e.b.id);
    if (!a || e.b.now) return;
    $(".t", a)!.innerHTML = titleHTML(e.b.title, q);
    $(".by", a)!.innerHTML = hl(e.b.author, q);
    if (e.pull) $(".pq", a)!.innerHTML = hl(e.pull, q);
    fillReview(e, q);
  }
  const EASE = "cubic-bezier(.2,.8,.2,1)";
  function toggle(e: Entry, open: boolean, animate = !reduced()) {
    const a = art(e.b.id);
    if (!a || !e.b.review || !e.long || expanded.has(e.b.id) === open) return;
    const box = $(".rv", a)!, q = norm(state.q);
    const from = box.getBoundingClientRect().height;
    if (open) expanded.add(e.b.id); else expanded.delete(e.b.id);
    fillReview(e, q);
    const to = box.getBoundingClientRect().height;
    if (!open) {
      // Bring the entry back into view if its top has scrolled away under the bar.
      const top = a.getBoundingClientRect().top, under = bar.getBoundingClientRect().bottom;
      if (top < under) scrollTo({ top: scrollY + top - under - 16, behavior: animate ? "smooth" : "auto" });
    }
    spy();
    if (!animate) return;
    const dur = Math.round(Math.min(560, Math.max(260, Math.abs(to - from) * 0.35)));
    if (!open) { // keep the full text visible while the box closes, then swap in the excerpt
      expanded.add(e.b.id); fillReview(e, q); a.classList.remove("open", "stuck"); expanded.delete(e.b.id);
      box.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: dur, easing: EASE }).finished.then(() => fillReview(e, norm(state.q)));
      return;
    }
    box.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: dur, easing: EASE });
    $$("p", box).forEach((p, k) => k && p.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: Math.min(k, 6) * 45 + 80, easing: "ease-out", fill: "backwards" }));
  }

  let lastQ: string | null = null;
  function apply() {
    const q = norm(state.q), rehl = q !== lastQ;
    lastQ = q;
    let total = 0;
    for (const b of reading) { const a = art(b.id); if (a) a.hidden = !match(b); }
    const nowSec = $("#jr-y-now");
    if (nowSec) { const k = reading.filter((b) => match(b)).length; nowSec.hidden = !k; total += k; }
    for (const g of years) {
      const sec = $(`#jr-y-${g.key}`)!;
      let k = 0, first = true;
      for (const b of g.books) {
        const a = art(b.id)!, ok = match(b);
        a.hidden = !ok;
        if (ok) { k++; a.classList.toggle("first", first); first = false; }
        if (rehl || !a.dataset.done) { fillEntry(entry(b.id), q); a.dataset.done = "1"; }
      }
      for (const d of $$(".dot", sec)) d.classList.toggle("off", !match(entry(d.dataset.book!).b));
      sec.hidden = !k; total += k;
      $(".shown", sec)!.textContent = k < g.books.length ? `${k} of ${g.books.length} shown` : "";
    }
    // Years with nothing matching leave the menu (disabled too: Safari ignores hidden options).
    for (const o of yearsEl.options) o.hidden = o.disabled = $(`#jr-y-${o.value}`)!.hidden;
    for (const c of $$(".chip")) c.setAttribute("aria-pressed", String(c.dataset.f === state.f));
    empty.hidden = !!total;
    if (!total) $("p", empty)!.textContent = q ? `Nothing matches “${state.q.trim()}”.` : "Nothing here yet.";
    hint.innerHTML = q ? `${total} found` : "<kbd>/</kbd>";
    live.textContent = q || state.f !== "all" ? `${plural(total, "book")} shown` : "";
    spy();
  }

  for (const c of $$(".chip")) c.addEventListener("click", () => { state.f = c.dataset.f!; apply(); syncURL(); }, { signal });
  qEl.value = state.q;
  let urlT = 0;
  qEl.addEventListener("input", () => { state.q = qEl.value; apply(); clearTimeout(urlT); urlT = setTimeout(() => syncURL(), 300); }, { signal });
  qEl.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (qEl.value) { qEl.value = ""; state.q = ""; apply(); syncURL(); } else qEl.blur();
  }, { signal });
  addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = document.activeElement as HTMLElement | null;
    if (t === qEl || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || "") || t?.isContentEditable) return;
    e.preventDefault(); qEl.focus(); qEl.select();
  }, { signal });
  $(".reset")!.addEventListener("click", () => { state.f = "all"; state.q = ""; qEl.value = ""; apply(); syncURL(); }, { signal });

  // Read more / Show less
  view.addEventListener("click", (ev) => {
    const btn = (ev.target as Element).closest<HTMLElement>(".expand");
    if (!btn) return;
    const e = entry(btn.closest<HTMLElement>(".e")!.dataset.id!), open = !expanded.has(e.b.id);
    toggle(e, open);
    syncURL(open ? `#book-${e.b.id}` : location.hash === `#book-${e.b.id}` ? "" : location.hash);
  }, { signal });

  // ---------- month strip ----------
  function showTip(mo: HTMLElement) {
    const y = mo.dataset.y!, m = +mo.dataset.m!, g = years.find((x) => x.key === y);
    const bs = g ? inMonth(g, m).reverse() : [];
    if (!bs.length) return hideTip();
    $$(".mo.hot").forEach((x) => x !== mo && x.classList.remove("hot"));
    mo.classList.add("hot");
    tip.innerHTML = `<b>${MONTHS_LONG[m]} ${y}</b><span class="c">${plural(bs.length, "book")}</span><ul>${bs.map((b) => `<li class="${match(b) ? "" : "off"}">${esc(short(b.title))}</li>`).join("")}</ul>`;
    const r = mo.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), innerWidth - tw - 8);
    let yy = r.top - th - 10;
    if (yy < bar.getBoundingClientRect().bottom + 8) yy = r.bottom + 10;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(yy)}px)`;
    tip.classList.add("on");
  }
  function hideTip() { tip.classList.remove("on"); $$(".mo.hot").forEach((x) => x.classList.remove("hot")); }
  const moOf = (ev: Event) => (ev.target as Element).closest<HTMLElement>(".mo");
  view.addEventListener("pointerover", (ev) => { const mo = moOf(ev); if (mo && ev.pointerType !== "touch") showTip(mo); }, { signal });
  view.addEventListener("pointerout", (ev) => { const mo = moOf(ev); if (mo && !mo.contains(ev.relatedTarget as Node)) hideTip(); }, { signal });

  // Reading now: covers tilt toward the pointer (up to 12°) and lift; they settle back when it leaves.
  if (matchMedia("(hover: hover)").matches && !reduced()) {
    view.addEventListener("pointermove", (ev) => {
      const nb = (ev.target as Element).closest<HTMLElement>(".nb"); if (!nb) return;
      const cv = nb.querySelector<HTMLElement>(".cv")!, r = cv.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width - 0.5, py = (ev.clientY - r.top) / r.height - 0.5;
      cv.style.transform = `translateY(-6px) rotateY(${(px * 14).toFixed(1)}deg) rotateX(${(-py * 10).toFixed(1)}deg)`;
      cv.style.setProperty("--sx", `${(-px * 14).toFixed(0)}px`);
    }, { signal });
    view.addEventListener("pointerout", (ev) => {
      const nb = (ev.target as Element).closest<HTMLElement>(".nb"); if (!nb || nb.contains(ev.relatedTarget as Node)) return;
      const cv = nb.querySelector<HTMLElement>(".cv")!; cv.style.transform = ""; cv.style.removeProperty("--sx");
    }, { signal });
  }
  addEventListener("scroll", hideTip, { passive: true, signal });
  view.addEventListener("click", (ev) => {
    const mo = moOf(ev);
    if (!mo) return;
    const key = `${mo.dataset.y}-${String(+mo.dataset.m! + 1).padStart(2, "0")}`;
    const target = $$(`.e[data-m="${key}"]`).find((a) => !a.hidden);
    if (target) reveal(target, false);
  }, { signal });

  // ---------- deep links ----------
  function flash(el: HTMLElement) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  function reveal(el: HTMLElement, expand = true, smooth = !reduced()) {
    const e = entries.get(el.dataset.id!);
    if (expand && e?.b.review) toggle(e, true, false);
    el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "instant" });
    if (el.classList.contains("e")) flash(el);
    else $(".cv", el)?.animate([{ boxShadow: "0 0 0 3px var(--accent)" }, { boxShadow: "0 0 0 3px transparent" }], { duration: 2000, easing: "ease-out" });
  }
  function openHash(smooth: boolean) {
    const m = /^#book-(\d+)$/.exec(location.hash);
    if (!m) return;
    const e = entries.get(m[1]!);
    if (!e) return;
    if (!match(e.b)) { state.f = "all"; state.q = ""; qEl.value = ""; apply(); syncURL(); }
    const a = art(e.b.id);
    if (a) reveal(a, true, smooth);
  }
  addEventListener("hashchange", () => openHash(!reduced()), { signal });
  // The year menu scrolls smoothly to the year (the page has no scroll-behavior of its own) and leaves
  // the hash alone. While it scrolls, the spy holds off so the menu doesn't flick through the years between.
  let jumping = 0;
  yearsEl.addEventListener("change", () => {
    const sec = $(`#jr-y-${yearsEl.value}`);
    if (!sec) return;
    clearTimeout(jumping);
    jumping = window.setTimeout(() => { jumping = 0; spy(); }, reduced() ? 0 : 900);
    sec.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
  }, { signal });
  $(".totop")!.addEventListener("click", (ev) => { ev.preventDefault(); scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); }, { signal });

  // ---------- sticky bar height, scroll spy ----------
  const ro = new ResizeObserver(() => root.style.setProperty("--bar", `${bar.offsetHeight}px`));
  ro.observe(bar);
  let spyRaf = 0;
  function spy() {
    cancelAnimationFrame(spyRaf);
    spyRaf = requestAnimationFrame(() => {
      const line = bar.getBoundingClientRect().bottom + 80;
      let cur: string | undefined;
      for (const s of $$(".yr")) { if (s.hidden) continue; if (s.getBoundingClientRect().top <= line) cur = s.dataset.key; }
      if (!cur) cur = $$(".yr").find((s) => !s.hidden)?.dataset.key;
      if (cur && !jumping && yearsEl.value !== cur) yearsEl.value = cur;
      // A pinned bar sits exactly 16px off the bottom edge; only then does it get its floating look.
      for (const a of $$(".e.open")) {
        const acts = $(".acts", a)!, el = getComputedStyle(acts).display === "contents" ? $(".expand", a)! : acts;
        a.classList.toggle("stuck", Math.abs(el.getBoundingClientRect().bottom - (innerHeight - 16)) < 1.5);
      }
    });
  }
  addEventListener("scroll", spy, { passive: true, signal });
  addEventListener("resize", spy, { signal });
  // The bar has no background until it sticks: a 1px sentinel above it says when it has.
  const sentinel = document.createElement("div");
  sentinel.className = "sentinel";
  bar.before(sentinel);
  const io = new IntersectionObserver(([e]) => bar.classList.toggle("stuck", !e!.isIntersecting));
  io.observe(sentinel);
  signal.addEventListener("abort", () => { ro.disconnect(); io.disconnect(); tip.remove(); cancelAnimationFrame(spyRaf); clearTimeout(jumping); });

  apply();
  if (/^#book-/.test(location.hash)) (document.fonts?.ready || Promise.resolve()).then(() => requestAnimationFrame(() => openHash(false)));
  // No colour sampling here: every cover is an image in front of its placeholder colour.
  // Years settle in as they scroll into view (see .seen in journal.css); the first is in view already.
  const seen = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add("seen"); seen.unobserve(e.target); } }, { rootMargin: "0px 0px -10% 0px" });
  for (const y of $$(".yr")) seen.observe(y);
  signal.addEventListener("abort", () => seen.disconnect());
  return shelf.books.length;
};
