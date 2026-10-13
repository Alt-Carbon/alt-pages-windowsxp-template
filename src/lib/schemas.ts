// One definition of each content file. The build validates content against these,
// so a broken file fails the build with a readable message instead of publishing a
// broken page. scripts/prepare.mjs writes the editor's config from the same shapes.
import { z } from "zod";
import accents from "./accents.json";
import kinds from "./kinds.json";

// The desktop's generated wallpapers, drawn on a canvas by src/scripts/xp/main.js.
export const WALLPAPERS = ["blue", "azul", "autumn", "ascent", "radiance", "plain"] as const;

const link = z.object({ label: z.string().min(1), url: z.string().min(1) });
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const Site = z.object({
  name: z.string().min(1),
  pronunciation: z.string().default(""),
  greeting: z.string().default(""),
  oneLiner: z.string().min(1),
  intro: z.string().default(""),
  place: z.string().default(""),
  employer: z.string().default(""),
  employerUrl: z.string().default(""),
  photo: z.string().default(""),
  social: z.array(link).default([]),
  goodreads: z.string().default(""),
  // Where the owner publishes elsewhere; their newest posts join the Writing page (src/worker/core/posts.js).
  medium: z.string().default(""),
  substack: z.string().default(""),
  grain: z.boolean().default(true),
  // How the Reading page draws the shelf; one module each in src/scripts/shelf/.
  shelf: z.enum(["journal", "gallery", "stacks", "turn"]).catch("stacks").default("stacks"),
  accent: z.enum(accents.map((a) => a.id) as [string, ...string[]]).default("aerospace-orange"),
  // The desktop: how it looks on a first visit. Visitors change wallpaper and theme for themselves.
  desktop: z.object({
    wallpaper: z.enum(WALLPAPERS).catch("blue").default("blue"),
    picture: z.string().default(""),          // the owner's own wallpaper image; used instead of `wallpaper` when set
    city: z.string().default(""),             // for local time and weather; empty falls back to About's "Based in" fact
    weather: z.boolean().default(true),
    notes: z.boolean().default(true),         // visitors' notes and margin notes, kept in their own browser
    boot: z.boolean().default(true),          // the start-up screen on the first page of a visit
    pinned: z.array(z.string()).default([]),  // writing slugs with their own desktop icon
  }).prefault({}),
  owner: z.string().default(""),
  repo: z.string().default(""),
  authWorker: z.string().default(""),
  advanced: z.object({ url: z.string().default(""), authWorker: z.string().default(""), owner: z.string().default(""), repo: z.string().default("") }).default({}),
});

export const Now = z.object({
  // Off unless the owner turns it on: a Now page only works if it is kept up to date.
  show: z.boolean().default(false),
  updated: isoDay,
  groups: z.array(z.object({ heading: z.string().min(1), items: z.array(z.string()) })),
});

const month = z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM");
export const About = z.object({
  paragraphs: z.array(z.string()),
  // Work history, newest first. An entry with no end date is the current role.
  experience: z.array(z.object({
    role: z.string().min(1),
    org: z.string().min(1),
    orgUrl: z.string().default(""),
    start: month,
    end: month.or(z.literal("")).nullish().transform((v) => v || ""),
    summary: z.string().default(""),
  })).default([]),
  cv: z.string().nullish().transform((v) => v || ""),
  contact: z.string().default(""),
  facts: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  shortBio: z.string().default(""),
});

// Kinds for Reading links and Research items (src/lib/kinds.json); the editor offers them as a dropdown.
export const LINK_KINDS = kinds.links as [string, ...string[]];
export const RESEARCH_KINDS = kinds.research as [string, ...string[]];

const oldLink = { title: z.string().min(1), by: z.string().default(""), note: z.string().default(""), url: z.string().min(1) };
export const Reading = z.object({
  // On by default: until a Goodreads profile is set, the page shows a sample shelf (the editor warns).
  show: z.boolean().default(true),
  intro: z.string().default(""),
  // Things worth reading, watching or listening to, newest first when dated.
  links: z.array(z.object({
    ...oldLink,
    kind: z.enum(LINK_KINDS).catch("Article").default("Article"),
    date: isoDay.or(z.literal("")).nullish().transform((v) => v || ""),
  })).default([]),
  // Before October 2026 links were split into these two lists; content.ts folds them into `links`.
  articles: z.array(z.object({ ...oldLink, date: isoDay })).default([]),
  misc: z.array(z.object({ ...oldLink, kind: z.string().default("") })).default([]),
});

// The Writing page itself (its pieces are content/writing/*.md). `hide` lists the addresses of
// Medium or Substack posts to leave off the page.
export const WritingPage = z.object({ intro: z.string().default(""), hide: z.array(z.string()).default([]) });

export const Research = z.object({
  intro: z.string().default(""),
  items: z.array(z.object({
    title: z.string().min(1),
    authors: z.string().default(""),
    venue: z.string().default(""),
    year: z.coerce.number().int(),
    kind: z.enum(RESEARCH_KINDS).catch("Paper").default("Paper"),
    url: z.string().default(""),
    note: z.string().default(""),
    links: z.array(link).default([]),
  })).default([]),
});
