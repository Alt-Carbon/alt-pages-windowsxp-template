// Runs before `astro dev` and `astro build`.
//  1. Works out which GitHub repository this is (git remote, else content/site.json).
//  2. Writes src/generated/build.json: owner and repo, for the meta tags the
//     dashboard and the subdomain proxy check.
//  3. Writes public/admin/config.yml, the editor's configuration, and copies the
//     pinned Sveltia CMS bundle next to it.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mediumSource, substackSource } from "../src/worker/core/posts.js";

// Writes only when the content differs, so running this beside `astro dev` doesn't make the
// dev server reload the page for files that didn't change.
function write(path, content) {
  if (existsSync(path) && readFileSync(path).equals(Buffer.from(content))) return;
  writeFileSync(path, content);
}

const site = JSON.parse(readFileSync("content/site.json", "utf8"));
const reading = JSON.parse(readFileSync("content/reading.json", "utf8"));

// Until a Goodreads profile is set, the Reading page shows a sample shelf (Adithya's, Goodreads user 19054312).
// The editor says so in the two places it matters, and the warning goes away on the build
// after a profile is added. YAML double-quoted strings, so no raw double quotes inside.
const SAMPLE = !String(site.goodreads || "").trim() && reading.show !== false;
const sampleWarning = SAMPLE
  ? "⚠️ Not set yet, so your Reading page is showing a sample shelf: Adithya’s, not yours. Paste your profile address here, or turn the Reading page off under Reading. "
  : "";

// The same for Medium and Substack: until one is set, the Writing page (if it has any pieces) also
// shows sample posts, Ev Williams's Medium stories and the On Substack newsletter.
const postSources = { medium: mediumSource(site.medium), substack: substackSource(site.substack) };
const pieces = existsSync("content/writing") ? readdirSync("content/writing").filter((f) => f.endsWith(".md")).length : 0;
const SAMPLE_POSTS = !postSources.medium && !postSources.substack && pieces > 0;
const postsWarning = SAMPLE_POSTS
  ? "⚠️ Neither Medium nor Substack is set yet, so the Writing page is showing sample posts (Ev Williams’s and On Substack’s), not yours. "
  : "";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const accents = JSON.parse(readFileSync("src/lib/accents.json", "utf8"));
// The kinds offered for Reading links and Research items, shared with src/lib/schemas.ts.
const { links: LINK_KINDS, research: RESEARCH_KINDS } = JSON.parse(readFileSync("src/lib/kinds.json", "utf8"));

function fromGit() {
  try {
    const url = execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = /github\.com[:/]([^/]+)\/([^/.\s]+)(?:\.git)?$/i.exec(url);
    return m ? `${m[1]}/${m[2]}` : "";
  } catch {
    return "";
  }
}
const adv = site.advanced || {};
const repo = process.env.SITE_REPO || fromGit() || adv.repo || site.repo || "";
const owner = repo.split("/")[0] || adv.owner || site.owner || "";
if (!repo) console.warn("prepare: could not tell which GitHub repository this is. Set `repo` in content/site.json (owner/name) so the editor can sign in.");

// The reading sync reads which Goodreads profile to follow from this file.
const goodreadsId = (/(?:user\/show\/|review\/list(?:_rss)?\/|^)(\d+)/.exec(String(site.goodreads || "").trim()) || [])[1] || null;
mkdirSync("public/reading", { recursive: true });
write("public/reading/config.json", JSON.stringify({ userId: goodreadsId }));
// And the posts sync, which Medium and Substack feeds to read.
mkdirSync("public/writing/elsewhere", { recursive: true });
write("public/writing/elsewhere/config.json", JSON.stringify(postSources));

mkdirSync("src/generated", { recursive: true });
// builtAt only moves when something else in the file changes.
const buildInfo = { owner, repo, template: `xp@${pkg.version}` };
let prev = {};
try { prev = JSON.parse(readFileSync("src/generated/build.json", "utf8")); } catch {}
const same = Object.entries(buildInfo).every(([k, v]) => prev[k] === v);
write("src/generated/build.json", JSON.stringify({ ...buildInfo, builtAt: same && prev.builtAt ? prev.builtAt : new Date().toISOString() }, null, 2));

// --- editor -----------------------------------------------------------------
mkdirSync("public/admin", { recursive: true });
write("public/admin/sveltia-cms.js", readFileSync("node_modules/@sveltia/cms/dist/sveltia-cms.js"));

const link = `{ label: Link, name: url, widget: string }`;
const links = (name, label, hint = "", pad = "      ") => `
${pad}- { label: ${label}, name: ${name}, widget: list, required: false, collapsed: true, summary: "{{fields.label}}"${hint ? `, hint: "${hint}"` : ""}, fields: [ { label: Label, name: label, widget: string }, ${link} ] }`;

// Where the editor signs in. Empty in Site settings means the company's sign-in
// worker; after leaving, a person puts their own copy's address there instead.
const DEFAULT_AUTH = "https://alt-pages-auth.manish-176.workers.dev";
const authWorker = (adv.authWorker || site.authWorker || DEFAULT_AUTH).replace(/\/$/, "");

const config = `# Generated by scripts/prepare.mjs from the content schemas. Do not edit by hand.
backend:
  name: github
  repo: ${repo || "OWNER/REPO"}
  branch: main
  base_url: ${authWorker}
  automatic_deployments: true
media_folder: public/media
public_folder: /media
slug: { encoding: ascii, clean_accents: true }
editor: { preview: false }
app_title: ${JSON.stringify(site.name + " · editor")}
logo_url: /admin/logo.svg
# One file each, opened straight into the editor.
singletons:
  - name: site
    label: Site settings
    icon: settings
    file: content/site.json
    format: json
    fields:
      - { label: Name, name: name, widget: string }
      - { label: Pronunciation, name: pronunciation, widget: string, required: false, hint: "Optional, e.g. /ˈɑː.ʃə ˈraʊ/" }
      - { label: Greeting, name: greeting, widget: string, required: false, hint: "What Run answers when a visitor types hello, e.g. Hi, I am Asha" }
      - { label: One-liner, name: oneLiner, widget: string, hint: "One sentence about you. The site's description in search results and link previews." }
      - { label: Second line, name: intro, widget: text, required: false, hint: "One or two more sentences, added to the description after the one-liner." }
      - { label: Place, name: place, widget: string, required: false }
      - { label: Employer, name: employer, widget: string, required: false }
      - { label: Employer link, name: employerUrl, widget: string, required: false }
      - { label: Photo, name: photo, widget: image, required: false, hint: "Shown in System Properties (My Computer), and in search results about you." }${links("social", "Social links", "Email first, as mailto:you@example.com")}
      - label: Desktop
        name: desktop
        widget: object
        collapsed: true
        required: false
        hint: "How your desktop looks on someone's first visit. Visitors can change the wallpaper and colour scheme for themselves."
        fields:
          - { label: Wallpaper, name: wallpaper, widget: select, default: blue, hint: "Drawn in the browser, in the spirit of the originals.", options: [ { label: "Blue: a soft blurred blue gradient", value: blue }, { label: "Azul: deep blue water and light", value: azul }, { label: "Autumn: a path through orange trees", value: autumn }, { label: "Ascent: mountains at sunset", value: ascent }, { label: "Radiance: soft blue beams", value: radiance }, { label: "Plain: the classic solid blue", value: plain } ] }
          - { label: Your own wallpaper, name: picture, widget: image, required: false, hint: "Optional. A photo used instead of the wallpaper above." }
          - { label: Your city, name: city, widget: string, required: false, hint: "Shown on the taskbar with your local time and weather, e.g. Bengaluru. Leave empty to use Based in from About." }
          - { label: Show the weather, name: weather, widget: boolean, default: true, required: false, hint: "Weather comes from Open-Meteo, a free service that needs no account." }
          - { label: Visitors can write notes, name: notes, widget: boolean, default: true, required: false, hint: "Visitors can write their own notes, and add margin notes to your writing. Notes stay in each visitor's browser: you never see them, and nobody else does. Your writing stays locked." }
          - { label: Start-up screen, name: boot, widget: boolean, default: true, required: false, hint: "A two-second boot screen on the first page of a visit." }
          - { label: Pinned to the desktop, name: pinned, widget: relation, collection: writing, value_field: "{{slug}}", search_fields: [title], display_fields: [title], multiple: true, required: false, hint: "Pieces of writing that get their own icon on the desktop." }
      - { label: Bookshelf style, name: shelf, widget: select, default: stacks, hint: "How the Reading window first shows your books. Visitors can switch styles.", options: [ { label: "Journal: a year-by-year reading log with your reviews", value: journal }, { label: "Gallery: large covers, a book opens in a panel tinted its own colour", value: gallery }, { label: "Stacks: books lying in piles by year, titles readable", value: stacks }, { label: "Turn: 3D books on a dark shelf that turn to face you", value: turn } ] }
      - { label: Accent colour, name: accent, widget: select, default: aerospace-orange, hint: "Not used by the XP desktop, which keeps the Luna blue. Kept so the same content works on the other templates.", options: [ ${accents.map((a) => `{ label: "${a.label}", value: ${a.id} }`).join(", ")} ] }
      - { label: Goodreads profile, name: goodreads, widget: string, required: false, hint: "${sampleWarning}Paste your Goodreads profile address. Your 'read' and 'currently reading' shelves appear on the Reading page. The profile must be public." }
      - { label: Medium, name: medium, widget: string, required: false, hint: "${postsWarning}Your Medium profile address or @handle (a publication works too). Your newest stories join the Writing page with a small Medium chip, each linking to the story on Medium. Medium only shares the latest 10." }
      - { label: Substack, name: substack, widget: string, required: false, hint: "${postsWarning}Your Substack address, e.g. yourname.substack.com or your own domain. Your newest posts join the Writing page with a small Substack chip, each linking to the post. Substack shares the latest 20." }
      - label: Advanced
        name: advanced
        widget: object
        collapsed: true
        required: false
        hint: "Only needed after leaving the company, or if a build cannot read the repository."
        fields:
          - { label: Site address, name: url, widget: string, required: false, hint: "Leave empty: the site fills in its own address when someone visits. Only set this (e.g. https://asha.example.com) if link previews show the wrong address." }
          - { label: Sign-in service, name: authWorker, widget: string, required: false, hint: "Leave empty while at the company. After leaving, the address of your own copy of the sign-in worker." }
          - { label: GitHub login, name: owner, widget: string, required: false }
          - { label: Repository, name: repo, widget: string, required: false, hint: "owner/name" }
  - name: now
    label: Now
    icon: calendar_today
    file: content/now.json
    format: json
    fields:
      - { label: Show the Now page, name: show, widget: boolean, default: false, required: false, hint: "A Now page says what you are focused on this month. Turn it on only if you will update it every month or two; when off, now.txt leaves the desktop." }
      - { label: Updated on, name: updated, widget: datetime, format: YYYY-MM-DD, time_format: false }
      - label: Groups
        name: groups
        widget: list
        collapsed: true
        summary: "{{fields.heading}}"
        fields:
          - { label: Heading, name: heading, widget: string }
          - { label: Items, name: items, widget: list, field: { label: Item, name: item, widget: string }, hint: "Use *asterisks* for italics and [text](link) for links." }
  - name: about
    label: About
    icon: person
    file: content/about.json
    format: json
    fields:
      - { label: Paragraphs, name: paragraphs, widget: list, field: { label: Paragraph, name: p, widget: text } }
      - label: Experience
        name: experience
        widget: list
        required: false
        collapsed: true
        summary: "{{fields.role}}, {{fields.org}}"
        hint: "Newest first. Leave the end date empty for your current role."
        fields:
          - { label: Role, name: role, widget: string }
          - { label: Organisation, name: org, widget: string }
          - { label: Organisation link, name: orgUrl, widget: string, required: false }
          - { label: Started, name: start, widget: datetime, format: YYYY-MM, time_format: false, date_format: YYYY-MM }
          - { label: Ended, name: end, widget: datetime, format: YYYY-MM, time_format: false, date_format: YYYY-MM, required: false }
          - { label: What you did, name: summary, widget: string, required: false, hint: "One line." }
      - { label: CV, name: cv, widget: file, required: false, hint: "Optional PDF, linked next to Experience." }
      - { label: Contact, name: contact, widget: text, required: false, hint: "Use [text](mailto:you@example.com) for the email link." }
      - { label: Facts, name: facts, widget: list, required: false, collapsed: true, summary: "{{fields.label}}: {{fields.value}}", hint: "Small details not said elsewhere on the page, e.g. where you are based, your time zone, languages.", fields: [ { label: Label, name: label, widget: string }, { label: Value, name: value, widget: string } ] }
      - { label: Short bio, name: shortBio, widget: text, required: false, hint: "Third person, two sentences. Shown with a Copy button, for anyone introducing you or listing you as a speaker." }
  - name: reading
    label: Reading
    icon: menu_book
    file: content/reading.json
    format: json
    fields:
          - { label: Show the Reading page, name: show, widget: boolean, default: true, required: false, hint: "${SAMPLE ? "⚠️ No Goodreads profile yet, so this page shows a sample shelf (Otis Chandler’s, the founder of Goodreads), not your books. Add your profile under Site settings, or turn this off to hide the page. " : ""}Off takes the Reading icon off the desktop." }
          - { label: Subtitle, name: intro, widget: text, required: false, hint: "One line at the top of the Reading window. Also its description in search results and link previews." }
  - name: writing_page
    label: Writing page
    icon: edit_note
    file: content/writing.json
    format: json
    fields:
          - { label: Subtitle, name: intro, widget: text, required: false, hint: "Its description in search results and link previews. Your pieces are under Writing; posts from Medium and Substack join them once those are set under Site settings." }
          - { label: Posts to leave out, name: hide, widget: list, required: false, collapsed: true, field: { label: Address, name: url, widget: string }, hint: "${postsWarning}Addresses of Medium or Substack posts that should not appear on the Writing page or the home page." }
  - name: research
    label: Research
    icon: science
    file: content/research.json
    format: json
    fields:
          - { label: Subtitle, name: intro, widget: text, required: false, hint: "A line or two at the top of the Research window. Also its description in search results and link previews." }
          - label: Publications and talks
            name: items
            widget: list
            collapsed: true
            summary: "{{fields.year}} · {{fields.title}}"
            hint: "Papers, preprints, reports, datasets, software and talks. The Research icon appears on the desktop once there is one item."
            fields:
              - { label: Title, name: title, widget: string }
              - { label: Authors, name: authors, widget: string, required: false, hint: "As cited, e.g. Meera Iyer, Asha Rao, Daniel Okafor. Your own name is put in bold for you." }
              - { label: Where, name: venue, widget: string, required: false, hint: "Journal, conference, preprint server or event." }
              - { label: Year, name: year, widget: number, value_type: int }
              - { label: Kind, name: kind, widget: select, default: Paper, options: [${RESEARCH_KINDS.join(", ")}] }
              - { label: Link, name: url, widget: string, required: false, hint: "The DOI or main page. The title links here." }
              - { label: Note, name: note, widget: string, required: false }${links("links", "More links", "PDF, Code, Data, Slides, Recording", "              ")}
collections:
  - name: writing
    label: Writing
    icon: edit_note
    folder: content/writing
    create: true
    format: frontmatter
    extension: md
    slug: "{{slug}}"
    summary: "{{title}} · {{date}}"
    sortable_fields: [date, title]
    fields:
      - { label: Title, name: title, widget: string }
      - { label: Date, name: date, widget: datetime, format: YYYY-MM-DD, time_format: false }
      - { label: One-line blurb, name: blurb, widget: string, required: false }
      - { label: Published elsewhere, name: link, widget: string, required: false, hint: "If the piece lives on another site, its address. The list links there instead." }
      - { label: Draft, name: draft, widget: boolean, default: false, required: false, hint: "Drafts are not published." }
      - { label: Body, name: body, widget: markdown }
`;
write("public/admin/config.yml", config);
const feeds = Object.values(postSources).filter(Boolean).map((s) => s.feed).join(" ") || "(none)";
console.log(`prepare: repo ${repo || "(unknown)"}, owner ${owner || "(unknown)"}, goodreads ${goodreadsId || "(none)"}, posts ${feeds}, editor config written`);
