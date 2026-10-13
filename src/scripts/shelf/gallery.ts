// Bookshelf style "gallery" (ported from prototype E · Gallery): big face-out covers grouped by the
// year they were read, the year pinned beside each group; a cover flies into a QuickView tinted in
// the book's own colour, with a 3D book, the numbers, the review and prev/next.
import "../../styles/shelf/gallery.css";
import {
  type Book, type RGB, type Shelf, type Style, NOW, colour, day, esc, groups, hex, human, links, lum, n, paint, paragraphs,
  pageSignal, reduced, rgbOf, sampleAll, short, stars,
} from "./shared";

// ---------- colour: OKLab, so tints keep the cover's hue at an even lightness ----------
// The base colour is shared.ts's sampled spine colour (colour map), never resampled here.
const lin = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gam = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
function oklab([R, G, B]: RGB): [number, number, number] {
  const r = lin(R), g = lin(G), b = lin(B);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
// OKLCh → sRGB, pulling chroma in until the colour fits the gamut.
function fromLch(L: number, C: number, h: number): RGB {
  let out: RGB = [0, 0, 0];
  for (let k = 0; k < 24; k++, C *= 0.88) {
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    out = rgb.map((x) => Math.min(255, Math.max(0, gam(Math.min(1, Math.max(0, x)))))) as RGB;
    if (rgb.every((x) => x > -0.0005 && x < 1.0005) || C < 0.002) return out;
  }
  return out;
}
const contrast = (x: RGB, y: RGB) => { const a = lum(x) + 0.05, b = lum(y) + 0.05; return a > b ? a / b : b / a; };
// Walk lightness away from the background until the text clears the target ratio (ink ≥ 4.5:1 and
// well beyond; the mute ≥ 4.8:1).
function fit(L: number, C: number, h: number, bg: RGB, target: number, dir: number): RGB {
  let c = fromLch(L, C, h);
  for (let k = 0; k < 50 && contrast(c, bg) < target; k++) c = fromLch((L += dir * 0.015), C, h);
  return c;
}
const rgba = (rgb: RGB, a: number) => `rgb(${rgb.map(Math.round).join(" ")} / ${a})`;
type Tone = { C: number; h: number };
const toneOf = (rgb: RGB): Tone => { const [, a, b] = oklab(rgb); return { C: Math.hypot(a, b), h: Math.atan2(b, a) }; };
function palette({ C, h }: Tone): Record<string, string> {
  const grey = C < 0.03, H = grey ? 1.35 : h, c = grey ? 0.014 : C; // greys get a warm paper
  const tl = fromLch(0.93, Math.min(c * 0.55, 0.06), H);
  const td = fromLch(0.26, Math.min(c * 0.5, 0.055), H);
  return {
    tl: hex(tl), il: hex(fit(0.25, Math.min(c * 0.45, 0.045), H, tl, 9, -1)), ml: hex(fit(0.47, Math.min(c * 0.4, 0.045), H, tl, 4.8, -1)),
    gl: hex(fromLch(0.985, Math.min(c * 0.3, 0.03), H)), sl: rgba(fromLch(0.42, Math.min(c * 0.9, 0.12), H), 0.55),
    td: hex(td), id: hex(fit(0.95, 0.012, H, td, 11, 1)), md: hex(fit(0.76, Math.min(c * 0.3, 0.03), H, td, 4.8, 1)),
    gd: hex(fromLch(0.34, Math.min(c * 0.55, 0.06), H)), sd: rgba(fromLch(0.08, Math.min(c * 0.4, 0.04), H), 0.75),
  };
}
// The hover shadow: the cover's hue at mid lightness (a warm neutral for greys).
const shade = (rgb: RGB) => { const t = toneOf(rgb); return hex(t.C >= 0.03 ? fromLch(0.5, Math.min(t.C, 0.13), t.h) : [60, 50, 40]); };
// Wait briefly for a colour still being sampled, so the first QuickView opens already tinted.
async function settled(b: Book) {
  for (let k = 0; k < 7 && colour.get(b.id) === null; k++) await new Promise((r) => setTimeout(r, 50));
}

const plural = (k: number) => `${n(k)} ${k === 1 ? "book" : "books"}`;
const E_OUT = "cubic-bezier(.22,1,.36,1)", E_IN = "cubic-bezier(.4,0,.2,1)";
const ars = new Map<string, number>(); // cover aspect ratios, measured as the images load
let searchBox: HTMLInputElement | null = null;

export const render: Style = (shelf, root) => {
  const books = shelf.books;
  const byId = new Map(books.map((b) => [b.id, b]));
  let query = "", visible: Book[] = [];
  const owner = shelf.owner;

  // ---------- gallery ----------
  const filtered = () => {
    const q = query.trim().toLowerCase();
    return q ? books.filter((b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)) : books;
  };
  const ph = (b: Book) => `<span class="ph"><b>${esc(short(b.title))}</b><i>${esc(b.author)}</i></span>`;
  const card = (b: Book, k: number) => {
    const ar = ars.get(b.id);
    const inner = b.cover ? `<img src="${esc(b.cover)}" alt="" ${k < 8 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"${ar ? ' class="ld"' : ""}>` : ph(b);
    const rgb = rgbOf(b);
    return `<button class="card" type="button" data-id="${esc(b.id)}" style="--c:${hex(rgb)};--sh:${shade(rgb)}" aria-haspopup="dialog" aria-label="${esc(`${b.title}, ${b.author}`)}">`
      + `<span class="cv"><span class="cover"${ar ? ` style="--ar:${ar}"` : ""}>${inner}</span></span>`
      + `<span class="meta"><span class="ct">${esc(short(b.title))}</span><span class="ca">${esc(b.author)}</span>${b.rating ? `<span class="cs" aria-hidden="true">${"★".repeat(b.rating)}</span>` : ""}</span></button>`;
  };
  const view = document.createElement("div");
  view.className = "view";
  function draw() {
    const list = filtered(), gs = groups(list);
    visible = gs.flatMap(([, bs]) => bs);
    let k = 0;
    view.innerHTML = list.length ? gs.map(([name, bs], i) => {
      const word = !/^\d{4}$/.test(name);
      return `<section class="sec" aria-labelledby="shelf-g-${i}"><div class="yr"><h2 id="shelf-g-${i}"${word ? ' class="word"' : ""}>${esc(name)}</h2><p>${plural(bs.length)}</p></div>`
        + `<div class="grid">${bs.map((b) => card(b, k++)).join("")}</div></section>`;
    }).join("") : `<p class="empty">No books match “${esc(query)}”.</p>`;
    hits.textContent = query.trim() ? plural(list.length) : "";
    for (const img of view.querySelectorAll<HTMLImageElement>(".cover img")) if (img.complete && img.naturalWidth) loaded(img);
  }
  function loaded(img: HTMLImageElement) {
    const c = img.closest<HTMLElement>(".card"); if (!c) return;
    const ar = img.naturalWidth / img.naturalHeight; ars.set(c.dataset.id!, ar);
    img.parentElement!.style.setProperty("--ar", String(ar)); img.classList.add("ld");
  }
  // shared's sampling paints --c on each card as its colour arrives; the shadow tint follows it.
  new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target as HTMLElement, rgb = colour.get(el.dataset.id || "");
      if (!rgb) continue;
      const sh = shade(rgb);
      if (el.style.getPropertyValue("--sh") !== sh) el.style.setProperty("--sh", sh);
    }
  }).observe(view, { attributes: true, attributeFilter: ["style"], subtree: true });
  view.addEventListener("load", (e) => { const t = e.target as HTMLElement; if (t.matches?.(".cover img")) loaded(t as HTMLImageElement); }, true);
  view.addEventListener("error", (e) => {
    const img = e.target as HTMLElement; if (!img.matches?.(".cover img")) return;
    const b = byId.get(img.closest<HTMLElement>(".card")!.dataset.id!); if (b) img.outerHTML = ph(b);
  }, true);

  // ---------- page: search, the gallery, the dialog ----------
  root.innerHTML = `<div class="controls" role="search"><label class="search"><span class="vh">Find a title or author</span><input type="search" placeholder="Find a title or author" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label><span class="hits" aria-live="polite"></span></div>`;
  root.append(view);
  const hits = root.querySelector<HTMLElement>(".hits")!;
  const q = root.querySelector<HTMLInputElement>(".search input")!;
  searchBox = q;

  const qv = document.createElement("dialog");
  qv.className = "shelf-gallery-qv";
  qv.setAttribute("aria-labelledby", "shelf-qv-title");
  qv.innerHTML = `<div class="scrim"></div>
  <article class="sheet">
    <button class="x" type="button" aria-label="Close" autofocus><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    <div class="bg" aria-hidden="true"></div>
    <div class="stage"><div class="fly"><div class="b3d"><div class="side"></div><div class="pages"></div><div class="front"></div></div><div class="floor" aria-hidden="true"></div></div></div>
    <div class="info">
      <div class="head"><p class="eyebrow"></p><h2 id="shelf-qv-title"></h2><p class="by"></p><dl class="nums"></dl><div class="tags"></div></div>
      <div class="rv" tabindex="0" role="region" aria-label="Review"></div>
      <div class="foot"><div class="actions"></div>
        <div class="pn"><span class="pos"></span>
          <button class="prev" type="button" aria-label="Previous book"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg></button>
          <button class="next" type="button" aria-label="Next book"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button>
        </div></div>
    </div>
  </article>`;
  root.append(qv);
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => qv.querySelector<T>(s)!;
  const sheet = $(".sheet"), scrim = $(".scrim"), bg = $(".bg"), fly = $(".fly"), bk = $(".b3d"), floor = $(".floor"), closeBtn = $(".x"), info = $(".info");
  const parts = () => [...sheet.querySelectorAll<HTMLElement>(".head > *, .rv, .foot")];
  const rest = () => getComputedStyle(bk).getPropertyValue("--rest").trim() || "none";
  let cur: Book | null = null, busy = false, token = 0;
  const coverEl = (b: Book) => root.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(b.id)}"] .cover`);
  const cardEl = (b: Book) => root.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(b.id)}"]`);
  const outsideView = (r: DOMRect) => r.bottom < 60 || r.top > innerHeight - 20;

  function setTint(b: Book) {
    const rgb = colour.get(b.id);
    const p = palette(rgb ? toneOf(rgb) : { C: 0, h: 0 });
    for (const [k, v] of Object.entries(p)) sheet.style.setProperty(`--${k}`, v);
    paint(bk, rgb || [70, 66, 60]);
  }
  function splitTitle(t: string): [string, string] {
    const i = t.indexOf(": ");
    if (i > 0) return [t.slice(0, i), t.slice(i + 2)];
    const m = /^(.*?)\s*(\([^)]*\))$/.exec(t);
    return m && m[1] ? [m[1], m[2]!.slice(1, -1)] : [t, ""];
  }
  function fill(b: Book) {
    setTint(b);
    fly.style.setProperty("--ar", String(ars.get(b.id) || 0.6667));
    bk.style.setProperty("--d", `${Math.round(Math.min(46, Math.max(18, (b.pages || 280) / 14)))}px`);
    $(".front").innerHTML = b.cover ? `<img src="${esc(b.cover)}" alt="Cover of ${esc(b.title)}">` : ph(b);
    $(".side").innerHTML = `<span>${esc(short(b.title))}</span>`;
    $(".eyebrow").textContent = b.now ? NOW : b.readAt ? `From ${b.readAt.slice(0, 4)}` : "From the shelf";
    const [main, sub] = splitTitle(b.title);
    $("h2").innerHTML = esc(main) + (sub ? `<span class="vh">: </span><span class="subt">${esc(sub)}</span>` : "");
    $(".by").innerHTML = `<span>${esc(b.author)}</span>` + (b.rating ? stars(b.rating) : "");
    const nums: [string, string][] = ([
      [b.pages ? n(b.pages) : "", "pages"],
      [b.rating ? `${b.rating}<small aria-hidden="true">★</small>` : "", "rating"],
      [b.avgRating ? b.avgRating.toFixed(2) : "", "Goodreads avg"],
      [b.published ? String(b.published) : "", "published"],
      [b.readAt ? esc(day(b.readAt).slice(0, -5)) : "", b.readAt ? `finished ${b.readAt.slice(0, 4)}` : ""],
    ] as [string, string][]).filter(([v]) => v);
    $(".nums").innerHTML = nums.map(([v, l]) => `<div><dt>${esc(l)}</dt><dd>${v}</dd></div>`).join("");
    $(".nums").hidden = !nums.length;
    $(".tags").innerHTML = (b.shelves || []).map((s) => `<span>${esc(human(s))}</span>`).join("");
    const rv = $(".rv");
    rv.innerHTML = b.review ? `<h3>${owner ? `${esc(owner)}’s review` : "Review"}</h3>${paragraphs(b.review)}`
      : `<p class="none">${b.now ? "Still reading, so no review yet." : "No review for this one."}</p>`;
    rv.scrollTop = 0; info.scrollTop = 0;
    $(".actions").innerHTML = links(b).join("");
    const pos = visible.indexOf(b);
    $(".pos").textContent = pos >= 0 ? `${pos + 1} of ${visible.length}` : "";
    history.replaceState(null, "", `#book-${b.id}`);
  }

  async function open(b: Book) {
    if (busy || qv.open) return;
    cur = b; busy = true;
    await settled(b);
    fill(b);
    const cov = coverEl(b), from = cov?.getBoundingClientRect();
    qv.showModal();
    const anims: Animation[] = [];
    if (reduced() || !cov || !from || outsideView(from)) {
      for (const el of [scrim, sheet]) anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced() ? 180 : 260, easing: "ease-out" }));
      await Promise.allSettled(anims.map((a) => a.finished));
      busy = false;
      return;
    }
    const to = fly.getBoundingClientRect(), s = from.width / to.width;
    cov.style.visibility = "hidden";
    const flight = fly.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${s})` }, { transform: "none" }], { duration: 640, easing: E_OUT });
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: "ease-out" });
    bg.animate([{ opacity: 0, transform: "scale(.965)" }, { opacity: 1, transform: "none" }], { duration: 460, easing: E_OUT });
    bk.animate([{ transform: "rotateY(0deg) rotateX(0deg)" }, { transform: rest() }], { duration: 760, easing: "cubic-bezier(.3,1.25,.5,1)" });
    floor.animate([{ opacity: 0 }, { opacity: 0.8 }], { duration: 360, delay: 360, easing: "ease-out", fill: "backwards" });
    closeBtn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 220, fill: "backwards" });
    parts().forEach((el, k) => el.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 480, delay: 150 + k * 45, easing: E_OUT, fill: "backwards" }));
    const done = () => { cov.style.visibility = ""; busy = false; };
    flight.finished.then(done, done);
  }

  async function close() {
    if (busy || !qv.open || !cur) return;
    busy = true;
    const cov = coverEl(cur);
    let to: DOMRect | null = null;
    if (cov) {
      let r = cov.getBoundingClientRect();
      if (outsideView(r) || r.top < 70) { cov.scrollIntoView({ block: "center" }); r = cov.getBoundingClientRect(); }
      to = r;
    }
    const anims: Animation[] = [];
    if (reduced() || !cov || !to) {
      for (const el of [scrim, sheet]) anims.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "forwards" }));
    } else {
      const from = fly.getBoundingClientRect(), s = to.width / from.width;
      cov.style.visibility = "hidden";
      anims.push(
        fly.animate([{ transform: "none" }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${s})` }], { duration: 480, easing: "cubic-bezier(.5,0,.15,1)", fill: "forwards" }),
        bk.animate([{ transform: rest() }, { transform: "rotateY(0deg) rotateX(0deg)" }], { duration: 420, easing: E_IN, fill: "forwards" }),
        floor.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 140, fill: "forwards" }),
        bg.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.975)" }], { duration: 300, delay: 60, easing: E_IN, fill: "forwards" }),
        scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-in", fill: "forwards" }),
        ...[...parts(), closeBtn].map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in", fill: "forwards" })),
      );
    }
    await Promise.allSettled(anims.map((a) => a.finished));
    qv.close();
    for (const a of anims) a.cancel();
    if (cov) cov.style.visibility = "";
    busy = false;
  }
  qv.addEventListener("close", () => {
    history.replaceState(null, "", location.pathname + location.search);
    const c = cur && cardEl(cur);
    if (c) { c.querySelector<HTMLElement>(".cover")!.style.visibility = ""; c.focus({ preventScroll: true }); }
  });

  async function step(d: number) {
    if (busy || !qv.open || !cur || !visible.length) return;
    const pos = visible.indexOf(cur), nb = visible[(pos + d + visible.length) % visible.length]!;
    cur = nb; const my = ++token;
    for (const el of [bk, floor, ...parts()]) for (const a of el.getAnimations()) if (a.effect?.getTiming().fill === "backwards") a.finish();
    if (reduced()) { fill(nb); return; }
    const outs = [
      bk.animate([{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: `${-d * 40}px 0` }], { duration: 170, easing: E_IN, fill: "forwards" }),
      floor.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 150, fill: "forwards" }),
      ...parts().map((el) => el.animate([{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: `${-d * 10}px 0` }], { duration: 150, easing: E_IN, fill: "forwards" })),
    ];
    await Promise.allSettled(outs.map((a) => a.finished));
    if (my !== token) { outs.forEach((a) => a.cancel()); return; }
    fill(nb);
    outs.forEach((a) => a.cancel());
    bk.animate([{ opacity: 0, translate: `${d * 48}px 0` }, { opacity: 1, translate: "0 0" }], { duration: 520, easing: E_OUT });
    floor.animate([{ opacity: 0 }, { opacity: 0.8 }], { duration: 360, delay: 160, fill: "backwards" });
    parts().forEach((el, k) => el.animate([{ opacity: 0, translate: `${d * 14}px 0` }, { opacity: 1, translate: "0 0" }], { duration: 420, delay: 40 + k * 30, easing: E_OUT, fill: "backwards" }));
  }

  view.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".card");
    const b = el && byId.get(el.dataset.id!);
    if (b) open(b);
  });
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("click", close);
  qv.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  $(".prev").addEventListener("click", () => step(-1));
  $(".next").addEventListener("click", () => step(1));
  qv.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest?.("a, input")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  });

  // ---------- search ----------
  // Filtering keeps the box where it is and brings the first result up under it.
  q.addEventListener("input", () => {
    query = q.value; draw();
    const top = view.getBoundingClientRect().top + scrollY - 16;
    if (scrollY > top) scrollTo(0, top);
  });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape" && q.value) { e.preventDefault(); q.value = ""; query = ""; draw(); } });
  {
    addEventListener("keydown", (e) => {
      if (e.key === "/" && searchBox && !document.querySelector("dialog[open]") && !(e.target as HTMLElement).closest?.("input, textarea")) { e.preventDefault(); searchBox.focus(); searchBox.select(); }
    }, { signal: pageSignal() });
  }

  draw();
  sampleAll(books, root);
  const deep = /^#book-(.+)$/.exec(location.hash);
  const target = deep && byId.get(decodeURIComponent(deep[1]!));
  if (target) {
    coverEl(target)?.scrollIntoView({ block: "center" });
    setTimeout(() => open(target), 450);
  }
  return books.length;
};
