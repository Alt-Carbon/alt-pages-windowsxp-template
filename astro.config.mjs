import { defineConfig } from "astro/config";

// Static output. Pages are written as /now.html and served at /now by Cloudflare's
// asset handling, so there are no trailing slashes in the addresses.
export default defineConfig({
  output: "static",
  build: { format: "file" },
  trailingSlash: "never",
  compressHTML: true,
  // Code in essays: a light and a dark theme; site.css picks one to match the page theme. The light one
  // is GitHub's high-contrast theme: the plain one's orange is too faint on the code background.
  markdown: { shikiConfig: { themes: { light: "github-light-high-contrast", dark: "github-dark" }, defaultColor: false } },
});
