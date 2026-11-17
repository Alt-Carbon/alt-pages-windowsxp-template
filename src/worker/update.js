// The weekly update, run by the site's own Worker: brings this site's repository up to date with
// the template it was made from, as one commit, which Cloudflare then builds and deploys. Nothing
// at the company is involved, and no GitHub workflow file is needed (Cloudflare's GitHub app
// can't write those, which is why the old workflow broke the Deploy button).
//
// What it does, with the same rules as scripts/update-from-template.mjs (src/worker/merge.js):
//   - the person's words and photos (content/, public/media/) and .github/ are never touched;
//   - wrangler.jsonc, package.json and package-lock.json are merged so the site keeps its own
//     Worker name, storage ids and package name;
//   - files the template no longer has are removed (outside the protected folders);
//   - nothing happens if Site settings → Advanced → "Get improvements automatically" is off.
//
// Files are compared by the Git fingerprints GitHub lists (blob SHAs), so nothing is hashed or
// fetched for files that haven't changed; the changed ones come from one archive of the template
// (a single request), so a big update stays within a Worker's request limit. If the commit
// doesn't build, Cloudflare keeps the site as it was.
//
//   runUpdate({ token, repo, templateRepo, fetch, branch }) →
//     { changed: false, reason } | { changed: true, commit, template, files: [paths], removed: [paths] }

import { isProtected, MERGE, optedOut } from "./merge.js";

const UA = "alt-pages-site-update";
const API = "https://api.github.com";
const text = (bytes) => new TextDecoder().decode(bytes);
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Git's fingerprint for a file: SHA-1 of "blob <size>\0" and the bytes.
export async function blobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

// The files in a .tar (as GitHub's archives are): path → { bytes, mode }. The first folder (the
// "owner-repo-sha/" GitHub puts everything in) is dropped. Long names come in PAX headers.
export function untar(buf) {
  const files = new Map();
  const field = (o, n) => text(buf.subarray(o, o + n)).replace(/\0.*$/s, "");
  let paxPath = null;
  for (let o = 0; o + 512 <= buf.length; ) {
    if (buf.subarray(o, o + 512).every((b) => b === 0)) break;
    const size = parseInt(field(o + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(buf[o + 156] || 48);
    const prefix = field(o + 345, 155);
    let name = (prefix ? `${prefix}/` : "") + field(o, 100);
    const body = buf.subarray(o + 512, o + 512 + size);
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(text(body));
      paxPath = m ? m[1] : null;
    } else if (type === "0" || type === "\0") {
      if (paxPath) name = paxPath;
      const path = name.split("/").slice(1).join("/");
      const mode = parseInt(field(o + 100, 8).trim() || "644", 8);
      if (path) files.set(path, { bytes: body, mode: mode & 0o111 ? "100755" : "100644" });
      paxPath = null;
    } else if (type !== "g") paxPath = null;
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runUpdate({ token, repo, templateRepo, fetch: f = fetch, branch = "main" }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) return { changed: false, reason: "The site doesn't know its repository." };
  if (!/^[\w.-]+\/[\w.-]+$/.test(templateRepo || "")) return { changed: false, reason: "The site doesn't know which template it came from." };
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": UA };
  const call = async (method, path, body) => {
    const res = await f(`${API}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${method} ${path}${data.message ? `: ${data.message}` : ""}`);
    return data;
  };

  // The site as it is now.
  const head = (await call("GET", `/repos/${repo}/git/ref/heads/${branch}`)).object.sha;
  const commit = await call("GET", `/repos/${repo}/git/commits/${head}`);
  const tree = await call("GET", `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) return { changed: false, reason: "The repository is too big to update this way." };
  const site = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, { sha: e.sha, mode: e.mode }]));
  const readSite = async (path) => text(fromB64((await call("GET", `/repos/${repo}/git/blobs/${site.get(path).sha}`)).content));
  if (site.has("content/site.json")) {
    try { if (optedOut(JSON.parse(await readSite("content/site.json")))) return { changed: false, reason: "Updates are turned off in Site settings." }; } catch { /* unreadable: go on */ }
  }

  // The template's latest files: their fingerprints from GitHub, and their bytes from one archive.
  const tplHead = (await call("GET", `/repos/${templateRepo}/git/ref/heads/main`)).object.sha;
  const tplCommit = await call("GET", `/repos/${templateRepo}/git/commits/${tplHead}`);
  const tplTree = await call("GET", `/repos/${templateRepo}/git/trees/${tplCommit.tree.sha}?recursive=1`);
  const tpl = new Map(tplTree.tree.filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755")).map((e) => [e.path, { sha: e.sha, mode: e.mode }]));
  const todo = [...tpl].filter(([path, t]) => !isProtected(path) && (MERGE[path] ? true : site.get(path)?.sha !== t.sha || site.get(path)?.mode !== t.mode)).map(([path]) => path);

  const entries = [], files = [], removed = [];
  if (todo.length) {
    const archive = await f(`${API}/repos/${templateRepo}/tarball/${tplHead}`, { headers });
    if (!archive.ok) throw new Error(`GitHub answered ${archive.status} for the template's archive`);
    const bytesOf = untar(await gunzip(new Uint8Array(await archive.arrayBuffer())));
    for (const path of todo) {
      const got = bytesOf.get(path);
      if (!got) throw new Error(`The template's archive has no ${path}`);
      const { mode } = tpl.get(path), mine = site.get(path);
      if (MERGE[path] && mine) {
        const merged = MERGE[path](text(got.bytes), await readSite(path));
        if ((await blobSha(new TextEncoder().encode(merged))) !== mine.sha) { entries.push({ path, mode: "100644", type: "blob", content: merged }); files.push(path); }
        continue;
      }
      if (mine && mine.sha === tpl.get(path).sha && mine.mode === mode) continue;
      // Text goes in the tree as it is; anything else as a blob first.
      let isText = !got.bytes.includes(0);
      try { new TextDecoder("utf-8", { fatal: true }).decode(got.bytes); } catch { isText = false; }
      if (isText) entries.push({ path, mode, type: "blob", content: text(got.bytes) });
      else entries.push({ path, mode, type: "blob", sha: (await call("POST", `/repos/${repo}/git/blobs`, { content: b64(got.bytes), encoding: "base64" })).sha });
      files.push(path);
    }
  }
  for (const path of site.keys()) {
    if (!tpl.has(path) && !isProtected(path)) { entries.push({ path, mode: "100644", type: "blob", sha: null }); removed.push(path); }
  }
  if (!entries.length) return { changed: false, reason: "Already up to date.", template: tplHead };

  const newTree = await call("POST", `/repos/${repo}/git/trees`, { base_tree: commit.tree.sha, tree: entries });
  const made = await call("POST", `/repos/${repo}/git/commits`, { message: `Update from the template (${templateRepo}@${tplHead.slice(0, 7)})`, tree: newTree.sha, parents: [head] });
  await call("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: made.sha, force: false });
  return { changed: true, commit: made.sha, template: tplHead, files, removed };
}
