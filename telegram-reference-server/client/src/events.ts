import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { z } from "zod";

// ── Event queue ───────────────────────────────────────────────────────

export type EnqueueFn = (msg: string) => void;

export function formatEvent(data: Record<string, unknown>): string {
  return `[Telegram event] Message from user ${data.user} in chat_id ${data.chat_id} (message_id ${data.message_id}): ${data.text}`;
}

// ── Push delivery ─────────────────────────────────────────────────────

export function startPushDelivery(
  client: Client,
  enqueue: EnqueueFn
): void {
  console.log("📡 Using push-based event delivery\n");

  client.fallbackNotificationHandler = async (notification: Notification) => {
    if (notification.method === "notifications/events/event") {
      const p = notification.params as Record<string, unknown>;
      const data = p.data as Record<string, unknown>;
      const msg = formatEvent(data);
      console.log(`\n📨 ${msg}`);
      enqueue(msg);
    } else if (notification.method === "notifications/events/active") {
      const p = notification.params as Record<string, unknown>;
      console.log(`✅ Subscribed: ${p.id}`);
    }
  };

  client
    .request(
      {
        method: "events/stream" as never,
        params: {
          subscriptions: [
            { id: "sub_telegram", name: "telegram.message", cursor: null },
          ],
        },
      } as never,
      z.object({}) as never,
      { timeout: 2147483647 }
    )
    .catch((err) => {
      console.error("events/stream ended:", err);
    });
}

// ── Poll delivery ─────────────────────────────────────────────────────

const PollResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      events: z.optional(z.array(z.record(z.string(), z.unknown()))),
      cursor: z.optional(z.string()),
      hasMore: z.optional(z.boolean()),
      nextPollSeconds: z.optional(z.number()),
      error: z.optional(z.object({ code: z.number(), message: z.string() })),
    })
  ),
});

export function startPollDelivery(
  client: Client,
  enqueue: EnqueueFn
): void {
  console.log("📡 Using poll-based event delivery\n");
  let cursor: string | null = null;
  let pollInterval = 5;
  let polling = true;

  (async () => {
    while (polling) {
      try {
        const result = await client.request(
          {
            method: "events/poll",
            params: {
              subscriptions: [
                { id: "sub_telegram", name: "telegram.message", cursor },
              ],
            },
          } as never,
          PollResultSchema as never
        );
        const typed = result as z.infer<typeof PollResultSchema>;
        let totalEvents = 0;
        for (const sub of typed.results) {
          if (sub.error) {
            console.error(`Poll error for ${sub.id}:`, sub.error.message);
            continue;
          }
          if (sub.cursor) cursor = sub.cursor;
          if (sub.nextPollSeconds) pollInterval = sub.nextPollSeconds;
          for (const evt of sub.events ?? []) {
            totalEvents++;
            const data = evt.data as Record<string, unknown>;
            const msg = formatEvent(data);
            console.log(`\n📨 ${msg}`);
            enqueue(msg);
          }
        }
        console.error(`[poll] cursor=${cursor} events=${totalEvents}`);
      } catch (err) {
        console.error("Poll error:", err);
      }
      await new Promise((r) => setTimeout(r, pollInterval * 1000));
    }
  })();

  process.on("beforeExit", () => {
    polling = false;
  });
}

// ── Webhook delivery ──────────────────────────────────────────────────

const SubscribeResultSchema = z.object({
  id: z.string(),
  secret: z.optional(z.string()),
  cursor: z.string(),
  refreshBefore: z.string(),
});

export async function startWebhookDelivery(
  client: Client,
  enqueue: EnqueueFn
): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("WEBHOOK_URL env var is required for --webhook mode");
    process.exit(1);
  }
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("WEBHOOK_SECRET env var is required for --webhook mode");
    process.exit(1);
  }
  console.log(`📡 Using webhook-based event delivery → ${webhookUrl}\n`);

  const subId = randomUUID();
  let refreshing = true;

  async function subscribe(): Promise<z.infer<typeof SubscribeResultSchema>> {
    const result = await client.request(
      {
        method: "events/subscribe",
        params: {
          id: subId,
          name: "telegram.message",
          delivery: { mode: "webhook", url: webhookUrl, secret: webhookSecret },
          cursor: null,
        },
      } as never,
      SubscribeResultSchema as never
    );
    return result as z.infer<typeof SubscribeResultSchema>;
  }

  const initial = await subscribe();
  console.log(`⏰ Refresh before: ${initial.refreshBefore}`);

  // Refresh loop
  (async () => {
    while (refreshing) {
      const refreshAt = new Date(initial.refreshBefore).getTime();
      const waitMs = Math.max((refreshAt - Date.now()) / 2, 5000);
      await new Promise((r) => setTimeout(r, waitMs));
      if (!refreshing) break;
      try {
        const refreshed = await subscribe();
        console.error(
          `[webhook] Refreshed, next before: ${refreshed.refreshBefore}`
        );
      } catch (err) {
        console.error("[webhook] Refresh failed:", err);
      }
    }
  })();

  process.on("beforeExit", () => {
    refreshing = false;
  });

  // Poll SQLite for events inserted by the webhook receiver
  const dbPath = process.env.WEBHOOK_DB ?? "./webhooks.db";
  const db = new Database(dbPath, { readonly: true, fileMustExist: false });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        payload TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  } catch {
    /* readonly — table will exist once receiver starts */
  }
  let lastId = 0;
  const query = db.prepare(
    "SELECT id, payload FROM events WHERE id > ? ORDER BY id LIMIT 50"
  );

  (async () => {
    while (refreshing) {
      try {
        const rows = query.all(lastId) as { id: number; payload: string }[];
        for (const row of rows) {
          lastId = row.id;
          const evt = JSON.parse(row.payload);
          const data = evt.data as Record<string, unknown>;
          const msg = formatEvent(data);
          console.log(`\n📨 ${msg}`);
          enqueue(msg);
        }
        if (rows.length > 0) {
          console.error(`[webhook] Polled ${rows.length} events from DB`);
        }
      } catch {
        /* DB may not exist yet */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}
