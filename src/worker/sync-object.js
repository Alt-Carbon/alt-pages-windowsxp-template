// One Durable Object per Goodreads user: it owns the sync. Its storage is
// strongly consistent (KV is not, which rules KV out for anything that changes
// every few seconds), it gets 30 s of CPU per request on every plan, and its
// alarm is the schedule, so no cron is needed. The SQLite backend is the one
// the free plan includes.

import { DurableObject } from "cloudflare:workers";
import { REFRESH_MS, RETRY_MS, due, freshMeta, runSync } from "./store.js";

export class ShelfSync extends DurableObject {
  running = false;

  async status() {
    const [meta, alarm, ask] = await Promise.all([this.ctx.storage.get("meta"), this.ctx.storage.getAlarm(), this.ctx.storage.get("ask")]);
    return { running: this.running, alarm, asked: ask?.trigger ?? null, lastRun: meta?.lastRun ?? null, syncedAt: meta?.syncedAt ?? null, walkedAt: meta?.walkedAt ?? null, pages: meta?.pages ?? 0 };
  }

  // The view straight from the object, for when KV has not caught up yet.
  view() {
    return this.ctx.storage.get("view");
  }

  // Ask for a run soon. `force` names the cycle; otherwise the run picks one by age, or does nothing.
  async kick(userId, trigger, force = null) {
    if (this.running) return "running";
    if (!(await this.ctx.storage.get("meta"))) await this.ctx.storage.put("meta", freshMeta(userId));
    await this.ctx.storage.put("ask", { trigger, force });
    await this.ctx.storage.setAlarm(Date.now());
    return "scheduled";
  }

  async alarm() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return;
    const ask = (await this.ctx.storage.get("ask")) || {};
    const kind = due(meta) || ask.force; // a walk that is due beats a refresh asked for by hand
    let wait = REFRESH_MS;
    if (kind && !this.running) {
      this.running = true;
      try {
        const view = await runSync(this.env, meta, kind, ask.trigger || "alarm");
        await this.ctx.storage.put("meta", meta);
        if (view) await this.ctx.storage.put("view", view);
        if (!meta.lastRun.ok) wait = RETRY_MS;
        console.log(JSON.stringify({ userId: meta.userId, ...meta.lastRun, pages: meta.lastRun.pages.length }));
      } catch (e) {
        // Logged rather than thrown: a thrown alarm is retried by the platform, which would repeat the whole run.
        console.error(`ShelfSync ${meta.userId}: ${e.stack || e}`);
        wait = RETRY_MS;
      } finally {
        this.running = false;
      }
    }
    await this.ctx.storage.delete("ask");
    await this.ctx.storage.setAlarm(Date.now() + wait);
  }
}
