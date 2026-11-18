# alt-pages-windowsxp-template

A personal website as a Windows XP desktop. Your pages are icons on a soft blue gradient; each opens in a Luna window you can drag, resize and minimise. about.txt opens in Notepad when someone arrives, Writing is a journal, Reading is your Goodreads bookshelf, and the Start menu, Run…, Display Properties, balloon tips, the boot screen and Turn Off Computer are all there. Built with Astro, edited with Sveltia CMS at `/admin`, hosted as a Cloudflare Worker. MIT licensed.

It is the Desktop template (`alt-pages-desktop-template`) in different clothes: the same content files, the same windows, journal, shelf and Worker, with the look redrawn as XP's Luna. Nothing in it is Microsoft's: the icons in `public/icons` are our own drawings, the wallpapers are painted on a canvas from a seed, and the fonts are the system's. Windows and Windows XP are trademarks of Microsoft Corporation; this project is not affiliated with or endorsed by Microsoft.

## Run it locally

```
npm install
npm run dev        # http://localhost:4321 (the templates use 4325 for this one: npm run dev -- --port 4325)
npm run build      # writes dist/
npm run preview    # serves dist/ through the Worker, the way Cloudflare will, at http://localhost:8787
npm test           # reading-sync and posts parser tests, no network
```

`npm run dev` and `npm run build` first run `scripts/prepare.mjs`, which reads the repository name from git, writes the editor's configuration to `public/admin/config.yml`, and writes the Goodreads profile id and the Medium/Substack sources to `public/reading/config.json` and `public/writing/elsewhere/config.json`. None of these are committed.

## Deploy

`wrangler.jsonc` describes the Worker: the built pages as static assets, the reading and posts syncs, a KV namespace, two Durable Objects and a 12-hour cron. The Worker is called `my-xp`, so it never collides with another template's site in the same Cloudflare account. `npm run deploy` builds and deploys to whichever account wrangler is logged into.

## Content

Everything on the site is a file under `content/`, the same files as the Sidebar and Desktop templates, so a person can switch templates without retyping anything. The editor at `/admin` edits them.

| File | Where it shows |
| --- | --- |
| `content/site.json` | Name, links, photo, Goodreads profile, Medium and Substack, bookshelf style, and the Desktop settings below |
| `content/about.json` | `about.txt` in Notepad, and System Properties |
| `content/now.json` | `now.txt` in Notepad (when switched on) |
| `content/writing/*.md` | Writing: one Markdown file per piece |
| `content/writing.json` | The Writing page's description, and posts to leave out |
| `content/research.json` | Research, by year, in an Explorer window |
| `content/reading.json` | Reading: the subtitle and the Links tab. Books come from Goodreads |

The shapes are defined once in `src/lib/schemas.ts`; the build checks every file and fails with a readable message if something is off. A window whose page is switched off or empty has no icon.

### Desktop settings

Under Site settings → Desktop in the editor (`desktop` in `content/site.json`, the same key the Desktop template uses):

| Setting | What it does |
| --- | --- |
| Wallpaper | Blue (a blurred gradient, the default), Azul, Autumn, Ascent, Radiance or Plain blue. Each is drawn in the browser from a fixed seed, in the spirit of the originals. A real photo saved as `public/media/wallpapers/<name>.jpg` (or .png, .webp) takes the painted one's place, on the desktop and in Display Properties; the template ships none, because XP's own wallpapers are Microsoft's |
| Your own wallpaper | A photo used instead |
| Your city | For your local time and weather in the tray. Empty uses About's "Based in" fact, then Place |
| Show the weather | Off removes the weather and time from the tray |
| Visitors can write notes | Visitors' own notes in Writing, and margin notes on your pieces |
| Start-up screen | The boot screen and Welcome screen on the first page of a visit |
| Pinned to the desktop | Pieces of writing that get their own icon |

The accent colour setting is ignored here (the desktop keeps the Luna blue) but stays in the file so the other templates can use it.

Visitors can change the wallpaper (or use a picture of their own), the colour scheme (Default blue, Olive Green, Silver) and switch to the Windows Classic style in Display Properties, right-click the desktop → Properties, or Start → Run (`wallpaper azul`, `scheme olive`, `classic`). The choices stay in their browser.

## What stays in a visitor's browser

Nothing a visitor does is sent anywhere. The desktop keeps it in their own browser's localStorage, under keys that start with `xp:`: wallpaper, colour scheme, icon positions, their own notes (`xp:notes`), margin notes (`xp:margins`), their uploaded wallpaper, and the date of their last visit, which drives the "since your last visit" balloon tip. You, the owner, never see any of it, and neither does anyone else.

Your writing is locked: visitors can read it, select it and keep private notes beside it, but not change it.

The only outside requests are two to [Open-Meteo](https://open-meteo.com), a free weather service that needs no account: one to look up your city (cached in the browser) and one for the current weather (at most every 20 minutes). When it rains where you are, it rains over the blue wallpaper.

## Every window is a page

Each window has an address of its own: `/about`, `/now`, `/writing`, `/writing/<slug>`, `/research`, `/reading`. The page at that address carries the window's content as ordinary HTML, so it reads as a normal page without JavaScript and to search engines; the script then turns it into the desktop with that window open. As visitors move between windows, the address bar follows the window in front, so a copied link opens the same window. A page carries the full text of one piece only; the journal fetches other pieces from their own pages when they are opened.

Titles, descriptions, canonical links, Open Graph and Twitter tags, structured data, a preview card per page under `/og/`, `/rss.xml`, `/sitemap.xml` and `/robots.txt` are made from the content, exactly as in the Sidebar template. The site's address isn't known at build time, so pages carry `https://__origin__` and the Worker swaps in the address the visitor used.

## Reading sync and posts

Unchanged from the Sidebar and Desktop templates. `src/worker/` reads the public Goodreads shelves named in `content/site.json` on a schedule, keeps them in KV, and serves them at `/reading/view.json`; Medium and Substack posts are read the same way and served at `/writing/elsewhere.json`. Until a profile is connected, the sample shelf and sample posts in `public/` are served and the editor says so. The Reading window draws the shelf with the four shelf styles (`src/scripts/shelf/`); Stacks is the default here.

## Signing in without the company

The editor signs in with GitHub, which needs a small server to turn a login code into a token. By default that is the company's sign-in service (Advanced → Sign-in service). Turn on Advanced → **Sign in through this site** and the site's own Worker is that server instead (`src/worker/auth.js`): publish, open `/auth/setup` on your site, and press the button. GitHub creates a private GitHub App on your account through its app manifest flow, sends the app's keys back to your Worker, which keeps them in its KV namespace, and then asks you to install the app on this repository. From then on `/admin` signs in through your own site, and nothing about it depends on anyone else. Only the owner of the repository named in the editor's config can complete setup, and a token is only ever handed to this site's own origin. If sign-in stops working, open `/auth/setup` again and create a new app.

## Layout

| Path | What |
| --- | --- |
| `src/pages/` | One file per address, each the desktop with one window open; plus the generated feeds, sitemap, icons and preview cards |
| `src/layouts/Desktop.astro` | The head, the desktop, the taskbar, Start menu, boot and Welcome screens, and every window's content |
| `src/components/` | The Writing journal, the Research Explorer window and the Reading window |
| `src/lib/desktop.ts` | What the desktop draws from the content: Notepad text, icons, System Properties |
| `src/lib/content.ts`, `schemas.ts`, `cards.ts` | Shared with the Sidebar template: loading and checking content, preview cards |
| `src/scripts/xp/main.js` | The desktop: windows (WinBox.js), wallpapers, colour schemes, journal and margin notes, shelf, balloon tips, time and weather, Run, Display Properties, Turn Off, easter eggs |
| `src/scripts/shelf/`, `src/styles/shelf/` | The bookshelf styles, shared with the Sidebar template |
| `src/styles/xp.css` | The whole stylesheet: Luna Blue, Olive Green, Silver and Classic, plus the page without JavaScript |
| `public/icons/` | The icon set, drawn for this template |
| `src/worker/` | The reading and posts syncs and the address stamping, shared with the Sidebar template |
| `public/admin/` | The editor's entry page; bundle and config are generated |
| `test/` | Parser tests |

## Easter eggs

Start → Run takes commands (`help` lists them). Notepad can't save. System Properties counts your words. Leave the desktop alone for two minutes. Log off, stand by, turn it off. Try the Konami code.

## Signing in, the dashboard and updates

- **Editor sign-in.** The editor at `/admin` signs in with GitHub through this site's own Worker (`src/worker/auth.js`), so nothing about signing in depends on the company. The first time, "Sign in with GitHub" opens `/auth/setup`: one click creates a small GitHub App on the owner's account, a second installs it on this repository. "Other sign-in service" under Site settings → Advanced overrides it.
- **Where the site lives.** Once a day the site tells the company dashboard its address, repository and template (`src/worker/hello.js`), so nobody has to copy it from Cloudflare. Nothing about visitors is sent. Empty "Company dashboard" under Site settings → Advanced turns it off.
- **Improvements.** `scripts/update-from-template.mjs` brings in this template's latest changes, leaving `content/`, `public/media/` and `.github/` alone and keeping the site's own Worker name, storage id and package name; run it, then build and test, before committing. It is not run automatically yet: the Deploy button cannot copy a GitHub Actions workflow into a new repository (Cloudflare's GitHub app has no permission for workflow files), so the weekly job will be added after the site is created, from the site's own sign-in app.

## Changing the look

Your own styles go in `content/custom.css`. Every page loads it after the template's styles, and template updates never touch it, so changes there last. `AGENTS.md` lists the colours, fonts and parts you can change, and the rules for coding assistants (Claude Code, Codex, Copilot) working in this repository: above all, that anything outside `content/`, `public/media/` and `.github/` is replaced by the weekly update.
