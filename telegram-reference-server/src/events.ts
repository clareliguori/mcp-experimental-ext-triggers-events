import { randomBytes, createHmac } from "node:crypto";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "grammy";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────

export interface TelegramEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: {
    chat_id: string;
    message_id: string;
    user: string;
    text: string;
    ts: string;
  };
  cursor: string;
}

// ── Ring buffer ───────────────────────────────────────────────────────

const MAX_BUFFER = 1000;
const eventBuffer: TelegramEvent[] = [];
let eventSeq = 0;

function nextCursor(): string {
  return String(++eventSeq);
}

function bufferEvent(event: TelegramEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();
}

function eventsSince(
  cursor: string | null,
  maxEvents: number
): { events: TelegramEvent[]; cursor: string } {
  if (cursor === null) return { events: [], cursor: String(eventSeq) };
  const start = Number(cursor);
  const batch = eventBuffer
    .filter((e) => Number(e.cursor) > start)
    .slice(0, maxEvents);
  const newCursor =
    batch.length > 0 ? batch[batch.length - 1].cursor : cursor;
  return { events: batch, cursor: newCursor };
}

// ── Push state ────────────────────────────────────────────────────────

function customNotification(
  method: string,
  params: Record<string, unknown>
): ServerNotification {
  return { method, params } as unknown as ServerNotification;
}

interface ActiveSub {
  id: string;
  name: string;
  cursor: string;
  notify: (n: ServerNotification) => Promise<void>;
}

const activeSubs = new Map<string, ActiveSub>();

// ── Webhook state ─────────────────────────────────────────────────────

const WEBHOOK_TTL_MS = 60 * 1000; // 1 minute (demo)

interface WebhookSub {
  id: string;
  name: string;
  url: string;
  secret: string;
  cursor: string;
  expiresAt: number;
}

const webhookSubs = new Map<string, WebhookSub>();

function webhookKey(url: string, id: string): string {
  return `${url}\0${id}`;
}

function pruneExpiredWebhooks(): void {
  const now = Date.now();
  for (const [key, sub] of webhookSubs) {
    if (sub.expiresAt < now) {
      console.error("[server]", `Webhook sub ${sub.id} expired`);
      webhookSubs.delete(key);
    }
  }
}

async function deliverWebhook(
  sub: WebhookSub,
  event: TelegramEvent
): Promise<void> {
  const body = JSON.stringify({
    id: sub.id,
    eventId: event.eventId,
    name: event.name,
    timestamp: event.timestamp,
    data: event.data,
    cursor: event.cursor,
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", sub.secret)
    .update(`${ts}.${body}`)
    .digest("hex");

  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MCP-Signature": `sha256=${sig}`,
        "X-MCP-Timestamp": ts,
      },
      body,
    });
    if (res.ok) {
      sub.cursor = event.cursor;
    } else {
      console.error(
        "[server]",
        `Webhook delivery to ${sub.url} failed: ${res.status}`
      );
    }
  } catch (err) {
    console.error("[server]", `Webhook delivery to ${sub.url} error:`, err);
  }
}

// ── Register event handlers on McpServer ──────────────────────────────

const subscriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  params: z.optional(z.record(z.string(), z.unknown())),
  cursor: z.nullable(z.string()),
});

export function registerEventHandlers(server: McpServer): void {
  const lowLevel = server.server;

  const telegramMessageEvent = {
    name: "telegram.message",
    description: "Fires when a message is received by the Telegram bot",
    delivery: ["push", "poll", "webhook"],
    payloadSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        user: { type: "string" },
        text: { type: "string" },
        ts: { type: "string", format: "date-time" },
      },
    },
  };

  // events/list
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/list"),
      params: z.optional(z.object({ cursor: z.optional(z.string()) })),
    }),
    async () => ({ events: [telegramMessageEvent] })
  );

  // events/poll
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/poll"),
      params: z.object({
        maxEvents: z.optional(z.number()),
        subscriptions: z.array(subscriptionSchema),
      }),
    }),
    async (req) => {
      const maxEvents = req.params.maxEvents ?? 50;
      const results = req.params.subscriptions.map((sub) => {
        if (sub.name !== "telegram.message") {
          return {
            id: sub.id,
            error: { code: -32001, message: "EventNotFound" },
          };
        }
        const { events, cursor } = eventsSince(sub.cursor, maxEvents);
        return { id: sub.id, events, cursor, hasMore: false, nextPollSeconds: 5 };
      });
      return { results };
    }
  );

  // events/stream (push)
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/stream"),
      params: z.object({ subscriptions: z.array(subscriptionSchema) }),
    }),
    async (req, extra) => {
      for (const sub of req.params.subscriptions) {
        if (sub.name !== "telegram.message") {
          await extra.sendNotification(
            customNotification("notifications/events/error", {
              id: sub.id,
              code: -32001,
              message: "EventNotFound",
            })
          );
          continue;
        }
        const cursor = sub.cursor ?? nextCursor();
        await extra.sendNotification(
          customNotification("notifications/events/active", {
            id: sub.id,
            cursor,
          })
        );
        activeSubs.set(sub.id, {
          id: sub.id,
          name: sub.name,
          cursor,
          notify: (n) => extra.sendNotification(n),
        });
      }
      return new Promise<{ _meta: Record<string, never> }>((resolve) => {
        extra.signal.addEventListener("abort", () => {
          for (const sub of req.params.subscriptions) activeSubs.delete(sub.id);
          resolve({ _meta: {} });
        });
      });
    }
  );

  // events/subscribe (webhook)
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/subscribe"),
      params: z.object({
        id: z.string(),
        name: z.string(),
        params: z.optional(z.record(z.string(), z.unknown())),
        delivery: z.object({
          mode: z.literal("webhook"),
          url: z.string(),
          secret: z.optional(z.string()),
        }),
        cursor: z.nullable(z.string()),
      }),
    }),
    async (req) => {
      pruneExpiredWebhooks();
      const { id, name, delivery, cursor } = req.params;
      if (name !== "telegram.message") throw new Error("EventNotFound");

      const key = webhookKey(delivery.url, id);
      const existing = webhookSubs.get(key);

      if (existing) {
        existing.name = name;
        existing.expiresAt = Date.now() + WEBHOOK_TTL_MS;
        if (cursor !== null) existing.cursor = cursor;
        if (delivery.secret) existing.secret = delivery.secret;
        return {
          id,
          cursor: existing.cursor,
          refreshBefore: new Date(existing.expiresAt).toISOString(),
        };
      }

      const secret =
        delivery.secret ?? `whsec_${randomBytes(24).toString("base64url")}`;
      const sub: WebhookSub = {
        id,
        name,
        url: delivery.url,
        secret,
        cursor: cursor ?? String(eventSeq),
        expiresAt: Date.now() + WEBHOOK_TTL_MS,
      };
      webhookSubs.set(key, sub);
      console.error(
        "[server]",
        `Webhook subscription created: ${id} → ${delivery.url}`
      );
      return {
        id,
        secret,
        cursor: sub.cursor,
        refreshBefore: new Date(sub.expiresAt).toISOString(),
      };
    }
  );

  // events/unsubscribe
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/unsubscribe"),
      params: z.object({
        id: z.string(),
        delivery: z.optional(z.object({ url: z.string() })),
      }),
    }),
    async (req) => {
      const { id, delivery } = req.params;
      if (!delivery?.url)
        throw new Error("delivery.url required for unauthenticated servers");
      const deleted = webhookSubs.delete(webhookKey(delivery.url, id));
      console.error(
        "[server]",
        `Webhook unsubscribe ${id}: ${deleted ? "removed" : "not found"}`
      );
      return {};
    }
  );
}

// ── Emit event from Grammy handler ────────────────────────────────────

export function emitTelegramEvent(ctx: Context): void {
  const from = ctx.from;
  const chat = ctx.chat;
  const msg = ctx.message;
  if (!from || !chat || !msg) return;

  const cursor = nextCursor();
  const event: TelegramEvent = {
    eventId: `evt_${cursor}`,
    name: "telegram.message",
    timestamp: new Date(msg.date * 1000).toISOString(),
    data: {
      chat_id: String(chat.id),
      message_id: String(msg.message_id),
      user: from.username ?? String(from.id),
      text: msg.text ?? msg.caption ?? "",
      ts: new Date(msg.date * 1000).toISOString(),
    },
    cursor,
  };

  console.error(
    "[server]",
    `Telegram message from ${event.data.user} in chat ${chat.id}: ${event.data.text}`
  );

  bufferEvent(event);

  for (const [, active] of activeSubs) {
    if (active.name !== "telegram.message") continue;
    active.cursor = cursor;
    active
      .notify(
        customNotification("notifications/events/event", {
          id: active.id,
          ...event,
        })
      )
      .catch((err) => {
        console.error("[server]", `Failed to push event to sub ${active.id}:`, err);
      });
  }

  pruneExpiredWebhooks();
  for (const [, sub] of webhookSubs) {
    if (sub.name !== "telegram.message") continue;
    deliverWebhook(sub, event).catch(() => {});
  }
}
