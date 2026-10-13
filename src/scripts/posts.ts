// Posts published on Medium or Substack, read in the browser from /writing/elsewhere.json (the site's
// own posts sync, or the sample shipped in public/ until an address is set in Site settings). The
// Writing page and the home page both add them to their lists with this.

// Everything the sync keeps per post (src/worker/core/posts.js normalise()).
export type Post = {
  id: string; source: "medium" | "substack"; title: string; url: string; date: string | null; blurb: string;
  image: string | null; tags: string[]; author: string | null; words: number; minutes: number | null;
};
export type Source = { url: string; feed: string; name: string | null; image: string | null; count: number; at: string | null };
export type PostsView = { sample?: boolean; syncing?: boolean; syncedAt: string | null; sources: Partial<Record<Post["source"], Source>>; posts: Post[] };

export const WHERE: Record<Post["source"], string> = { medium: "Medium", substack: "Substack" };

export async function loadPosts(): Promise<PostsView | null> {
  try {
    const r = await fetch("/writing/elsewhere.json", { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as PostsView;
  } catch {
    return null;
  }
}

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (iso: string | null | undefined) => (iso ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : "");

// An address as the editor's "Posts to leave out" list is matched: no scheme, query, hash or trailing slash.
export const norm = (u: string) => String(u || "").trim().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

// The posts to show, newest first, minus the ones the owner left out.
export function visible(view: PostsView, hide: string[]): Post[] {
  const out = new Set(hide.map(norm).filter(Boolean));
  return view.posts.filter((p) => !out.has(norm(p.url)));
}

// The small chip that says where a piece lives.
export const chip = (where: string) => `<span class="where" aria-hidden="true">${esc(where)}</span>`;

// A row for the Writing page, the same markup as PostRow.astro gives a piece published elsewhere.
export function postRow(p: Post, blurb = true): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "in";
  li.dataset.sort = p.date || "";
  li.dataset.id = p.id;
  const where = WHERE[p.source] || p.source;
  li.innerHTML = `<span><a href="${esc(p.url)}">${esc(p.title)}<span class="ext" aria-hidden="true">↗</span><span class="vh"> (on ${esc(where)})</span></a>${chip(where)}`
    + (blurb && p.blurb ? `<span class="n">${esc(p.blurb)}</span>` : "") + `</span><span class="r">${day(p.date)}</span>`;
  return li;
}

// Puts a row in before the first row older than it, by data-sort; rows already there stay as they are.
export function insertByDate(ul: HTMLElement, li: HTMLElement) {
  const sort = li.dataset.sort || "";
  const older = [...ul.children].find((row) => ((row as HTMLElement).dataset.sort || "") < sort);
  ul.insertBefore(li, older ?? null);
}

// "Synced from my Medium and Substack, 12 Oct 2026." for a synced view; nothing for the sample.
export function syncNote(view: PostsView): string {
  if (view.sample || !view.syncedAt) return "";
  const names = (Object.keys(WHERE) as Post["source"][]).filter((k) => view.sources[k])
    .map((k) => `<a href="${esc(view.sources[k]!.url)}">${WHERE[k]}</a>`);
  if (!names.length) return "";
  return `Synced from my ${names.join(" and ")}, ${day(view.syncedAt.slice(0, 10))}.`;
}
