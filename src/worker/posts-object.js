// One Durable Object per pair of Medium and Substack feeds: it owns the sync, the same way ShelfSync
// (sync-object.js) owns the Goodreads one. Its alarm is the schedule: a refresh every 12 hours,
// an hour after a failed run. The feeds are small (the newest 10 or 20 posts), so a run is one
// request per feed.

import { DurableObject } from "cloudflare:workers";
import { REFRESH_MS, RETRY_MS, freshMeta, runPosts } from "./posts-store.js";

export class PostSync extends DurableObject {
  running = false;

  async status() {
    const [meta, alarm, ask] = await Promise.all([this.ctx.storage.get("meta"), this.ctx.storage.getAlarm(), this.ctx.storage.get("ask")]);
    return { running: this.running, alarm, asked: ask?.trigger ?? null, lastRun: meta?.lastRun ?? null, syncedAt: meta?.syncedAt ?? null };
  }

  // The view straight from the object, for when KV has not caught up yet.
  view() {
    return this.ctx.storage.get("view");
  }

  // Ask for a run soon. `sources` is what the site is set to follow (from the built config).
  async kick(sources, trigger, force = false) {
    if (this.running) return "running";
    if (!(await this.ctx.storage.get("meta"))) await this.ctx.storage.put("meta", freshMeta(sources));
    await this.ctx.storage.put("ask", { trigger, force });
    await this.ctx.storage.setAlarm(Date.now());
    return "scheduled";
  }

  async alarm() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return;
    const ask = (await this.ctx.storage.get("ask")) || {};
    const stale = !meta.syncedAt || Date.now() - Date.parse(meta.syncedAt) > REFRESH_MS - 60e3;
    const failed = meta.lastRun && !meta.lastRun.ok && Date.now() - Date.parse(meta.lastRun.at) > RETRY_MS - 60e3;
    let wait = REFRESH_MS;
    if ((stale || failed || ask.force) && !this.running) {
      this.running = true;
      try {
        const view = await runPosts(this.env, this.ctx.storage, meta, ask.trigger || "alarm");
        await this.ctx.storage.put("meta", meta);
        await this.ctx.storage.put("view", view);
        if (!meta.lastRun.ok) wait = RETRY_MS;
        console.log(JSON.stringify({ posts: meta.name, ...meta.lastRun }));
      } catch (e) {
        // Logged rather than thrown: a thrown alarm is retried by the platform, which would repeat the run.
        console.error(`PostSync ${meta.name}: ${e.stack || e}`);
        wait = RETRY_MS;
      } finally {
        this.running = false;
      }
    }
    await this.ctx.storage.delete("ask");
    await this.ctx.storage.setAlarm(Date.now() + wait);
  }
}
