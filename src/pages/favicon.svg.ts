// The favicon: the owner's initials on their accent colour, made at build time.
import type { APIRoute } from "astro";
import { faviconSvg } from "../lib/cards";

export const GET: APIRoute = async () => new Response(await faviconSvg(), { headers: { "content-type": "image/svg+xml" } });
