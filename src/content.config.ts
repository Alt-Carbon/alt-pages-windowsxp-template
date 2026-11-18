import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Writing: one Markdown file per piece in content/writing. The editor creates them.
const writing = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./content/writing" }),
  schema: z.object({
    title: z.string().min(1),
    date: z.coerce.date(),
    blurb: z.string().nullish().transform((v) => v ?? ""),
    link: z.string().url().nullish().transform((v) => v || undefined),   // set when the piece lives elsewhere
    draft: z.boolean().nullish().transform((v) => Boolean(v)),
  }),
});

// Your pages: one Markdown file per page in content/pages, made in the editor. Each gets its own
// address (the file name) and a place in the menu after the template's pages.
const pages = defineCollection({
  loader: glob({ pattern: "*.md", base: "./content/pages" }),
  schema: z.object({
    title: z.string().min(1),
    show: z.boolean().nullish().transform((v) => v !== false),
    photo: z.string().nullish().transform((v) => v || ""),
    description: z.string().nullish().transform((v) => v || ""),
  }),
});

export const collections = { writing, pages };
