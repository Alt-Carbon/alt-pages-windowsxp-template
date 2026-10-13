// The icon iOS uses for bookmarks and the home screen (it rounds the corners itself).
import type { APIRoute } from "astro";
import { touchIconPng } from "../lib/cards";

export const GET: APIRoute = async () => new Response(await touchIconPng(), { headers: { "content-type": "image/png" } });
