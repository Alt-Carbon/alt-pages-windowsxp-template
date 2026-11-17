// Brings this site up to date with the template it was made from, without anything run by the
// company: .github/workflows/update.yml runs it once a week on GitHub, then builds and tests the
// result, and only pushes it to main (which redeploys the site) if both pass.
//
//  1. Reads which template from package.json (`portfolio.templateRepo`). Stops if Site settings →
//     Advanced → "Get improvements automatically" is off (`advanced.autoUpdate: false`).
//  2. Fetches the template's main branch into a throwaway repository in the temp folder.
//  3. Copies the template's files over this site's, except the protected ones: content/ (the
//     words and settings), public/media/ (uploaded photos and files) and .github/ (GitHub does not
//     let the workflow's token change workflow files). The same rules as the dashboard's update
//     pull requests (alt-pages-platform/dashboard/src/update.js), except that wrangler.jsonc is
//     merged instead of skipped: the template's version, with this site's Worker name, KV
//     namespace ids and any routes. package.json and package-lock.json keep this site's name.
//     Files the site has that the template no longer has are removed, again except protected ones.
//  4. Stages exactly those changes in git and writes `changed` and `sha` to $GITHUB_OUTPUT.
//     Nothing changed: nothing staged, `changed=false`.
//
// node scripts/update-from-template.mjs              update the working tree and stage it
// node scripts/update-from-template.mjs --dry-run    only say what would change
// node scripts/update-from-template.mjs --from=<git url or path>   another source, for trying it out
//
// The planning and merging are pure functions, exported for test/update.test.mjs.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isProtected, MERGE } from "../src/worker/merge.js";
export * from "../src/worker/merge.js";

const bytes = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v)));

// template, site: Map of path → contents (Buffer or string). The site's map is its tracked files.
// Returns the files to write (path → Buffer) and the paths to remove; both empty when up to date.
export function planUpdate(template, site) {
  const write = new Map(), remove = [];
  for (const [path, content] of template) {
    if (isProtected(path)) continue;
    let next = bytes(content);
    if (MERGE[path] && site.has(path)) next = Buffer.from(MERGE[path](next.toString("utf8"), bytes(site.get(path)).toString("utf8")));
    if (!site.has(path) || !bytes(site.get(path)).equals(next)) write.set(path, next);
  }
  for (const path of site.keys()) if (!template.has(path) && !isProtected(path)) remove.push(path);
  return { write, remove: remove.sort() };
}

// --- running it ----------------------------------------------------------------------------

const git = (args, opts = {}) => execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"], ...opts });

// Every file on the template's main branch, and the commit it came from.
function fetchTemplate(source) {
  const dir = mkdtempSync(join(tmpdir(), "template-"));
  try {
    git(["init", "--quiet", "--bare", dir]);
    git(["-C", dir, "fetch", "--quiet", "--depth=1", "--no-tags", source, "main"]);
    const sha = git(["-C", dir, "rev-parse", "FETCH_HEAD"]).toString().trim();
    // mode type sha<TAB>path, NUL-separated. Only regular files: no links, no submodules.
    const entries = git(["-C", dir, "ls-tree", "-r", "-z", "FETCH_HEAD"]).toString("utf8").split("\0").filter(Boolean)
      .map((line) => { const [meta, path] = line.split("\t"); const [mode, type, blob] = meta.split(" "); return { mode, type, blob, path }; })
      .filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755"));
    // One `cat-file --batch` for all of them: "<sha> blob <size>\n<bytes>\n" each.
    const out = git(["-C", dir, "cat-file", "--batch"], { input: entries.map((e) => e.blob).join("\n") + "\n" });
    const files = new Map();
    let at = 0;
    for (const e of entries) {
      const nl = out.indexOf(10, at);
      const size = Number(out.subarray(at, nl).toString().split(" ")[2]);
      files.set(e.path, out.subarray(nl + 1, nl + 1 + size));
      at = nl + 1 + size + 1;
    }
    return { sha, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The site's tracked files as they are in the working tree.
function siteFiles() {
  const files = new Map();
  for (const path of git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean)) {
    if (existsSync(path)) files.set(path, readFileSync(path));
  }
  return files;
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function main(argv) {
  const dry = argv.includes("--dry-run");
  const from = argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);
  const repo = templateRepoOf(JSON.parse(readFileSync("package.json", "utf8")));
  if (!repo && !from) {
    console.log("update: package.json does not name a template (portfolio.templateRepo), so there is nothing to update from.");
    return output({ changed: false });
  }
  let site = {};
  try { site = JSON.parse(readFileSync("content/site.json", "utf8")); } catch {}
  if (optedOut(site)) {
    console.log("update: automatic updates are turned off (Site settings → Advanced → Get improvements automatically).");
    return output({ changed: false });
  }

  const source = from || `https://github.com/${repo}.git`;
  const { sha, files } = fetchTemplate(source);
  const short = sha.slice(0, 7);
  const { write, remove } = planUpdate(files, siteFiles());
  if (!write.size && !remove.length) {
    console.log(`update: already up to date with ${repo || source} at ${short}.`);
    return output({ changed: false, sha: short });
  }
  for (const path of write.keys()) console.log(`update ${path}`);
  for (const path of remove) console.log(`remove ${path}`);
  if (dry) {
    console.log(`update: ${write.size} to update, ${remove.length} to remove, from ${repo || source} at ${short}. Dry run: nothing changed.`);
    return output({ changed: false, sha: short });
  }
  for (const [path, content] of write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (write.size) git(["add", "-f", "--", ...write.keys()]);
  if (remove.length) git(["rm", "--quiet", "--", ...remove]);
  console.log(`update: ${write.size} updated, ${remove.length} removed, from ${repo || source} at ${short}. Staged, not committed.`);
  output({ changed: true, sha: short });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`update: ${e.message}`);
    process.exit(1);
  });
}
