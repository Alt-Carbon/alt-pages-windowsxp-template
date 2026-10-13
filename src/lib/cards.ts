// Build-time images: the favicon and Apple touch icon (the accent colour, nothing else) and a
// 1200×630 link-preview card per page.
// satori lays out the card and turns its text into shapes (so no fonts are needed to view it),
// resvg turns that SVG into a PNG. The fonts are the self-hosted fallbacks, since Iowan Old Style
// and San Francisco can't be shipped.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { accent, site } from "./content";

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => readFileSync(require.resolve(`${pkg}/files/${file}`));
const fonts = [
  { name: "Garamond", data: font("@fontsource/eb-garamond", "eb-garamond-latin-500-normal.woff"), weight: 500 as const, style: "normal" as const },
  { name: "Geist", data: font("@fontsource/geist", "geist-latin-400-normal.woff"), weight: 400 as const, style: "normal" as const },
  { name: "Geist", data: font("@fontsource/geist", "geist-latin-600-normal.woff"), weight: 600 as const, style: "normal" as const },
];

// Cards are dark so every neon accent reads at full strength.
const BG = "#111111", INK = "#f2f2f2", MUTE = "#969696", NEON = accent.dark;


type Node = { type: string; props: Record<string, unknown> };
// satori reads any array as several children: a single child goes in as itself, none as nothing.
const h = (type: string, style: Record<string, unknown>, ...children: (Node | string | false | undefined)[]): Node => {
  const kids = children.filter((c) => c !== false && c !== undefined);
  return { type, props: { style, children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids } };
};

const svg = (node: Node, width: number, height: number) => satori(node as any, { width, height, fonts });
const png = async (node: Node, width: number, height: number) =>
  new Uint8Array(new Resvg(await svg(node, width, height), { fitTo: { mode: "width", value: width } }).render().asPng());

// The favicon is a circle of the accent colour. The touch icon is a full square of it, because iOS
// masks it to a rounded square itself and would fill a transparent corner with black.
export const faviconSvg = async () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="${NEON}"/></svg>`;
export const touchIconPng = () => png(h("div", { width: 180, height: 180, background: NEON }), 180, 180);

export interface Card { title: string; subtitle?: string; kicker?: string }
export function cardPng({ title, subtitle, kicker }: Card) {
  const titleSize = title.length > 60 ? 60 : title.length > 32 ? 72 : 88;
  return png(
    h("div", { width: 1200, height: 630, display: "flex", flexDirection: "column", background: BG, padding: "64px 80px", fontFamily: "Geist", color: INK },
      h("div", { display: "flex", alignItems: "center", gap: 16, fontSize: 30, color: MUTE },
        h("div", { width: 28, height: 28, borderRadius: 14, background: NEON }),
        site.name),
      h("div", { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 24 },
        h("div", { fontFamily: "Garamond", fontWeight: 500, fontSize: titleSize, lineHeight: 1.08, letterSpacing: "-0.01em", lineClamp: 3, textWrap: "balance", display: "block" }, title),
        subtitle && h("div", { fontSize: 32, lineHeight: 1.35, color: MUTE, lineClamp: 2, display: "block" }, subtitle)),
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 26, color: MUTE },
        h("div", { display: "flex" }, kicker ?? ""),
        h("div", { width: 120, height: 6, borderRadius: 3, background: NEON }))),
    1200, 630);
}
