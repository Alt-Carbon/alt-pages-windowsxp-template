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

export const collections = { writing };
