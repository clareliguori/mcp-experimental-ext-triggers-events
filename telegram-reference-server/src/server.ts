#!/usr/bin/env node
/**
 * Telegram MCP Server — exposes Telegram Bot API operations as MCP tools
 * and inbound Telegram messages as MCP Events (push and poll delivery).
 *
 * Supports stdio (default) and HTTP (--http) transports.
 * Uses Grammy for Telegram Bot API interactions.
 * Requires TELEGRAM_BOT_TOKEN env var.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  isInitializeRequest,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Bot } from "grammy";
import type { Context } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import { z } from "zod";

// Load .env if present (shell env takes precedence)
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* missing file is fine */
}

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[server]", "TELEGRAM_BOT_TOKEN env var is required");
    process.exit(1);
  }
  return token;
}

// ── Shared event types ────────────────────────────────────────────────

interface TelegramEvent {
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

// ── Ring buffer for poll delivery ─────────────────────────────────────

const MAX_BUFFER = 1000;
const eventBuffer: TelegramEvent[] = [];
let eventSeq = 0;

function nextCursor(): string {
  return String(++eventSeq);
}

function bufferEvent(event: TelegramEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER) {
    eventBuffer.shift();
  }
}

function eventsSince(cursor: string | null, maxEvents: number): { events: TelegramEvent[]; cursor: string } {
  if (cursor === null) {
    // "Start from now" — return no events, just the current cursor
    return { events: [], cursor: String(eventSeq) };
  }
  const start = Number(cursor);
  const matching = eventBuffer.filter((e) => Number(e.cursor) > start);
  const batch = matching.slice(0, maxEvents);
  const newCursor = batch.length > 0 ? batch[batch.length - 1].cursor : cursor;
  return { events: batch, cursor: newCursor };
}

// ── Push event state ──────────────────────────────────────────────────

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

// ── Webhook subscription state ────────────────────────────────────────

const WEBHOOK_TTL_MS = 60 * 1000; // 1 minute (demo)

interface WebhookSub {
  id: string;
  name: string;
  url: string;
  secret: string;
  cursor: string;
  expiresAt: number;
}

// Keyed by (url, id) for unauthenticated servers per the spec
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

async function deliverWebhook(sub: WebhookSub, event: TelegramEvent): Promise<void> {
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
      console.error("[server]", `Webhook delivery to ${sub.url} failed: ${res.status}`);
    }
  } catch (err) {
    console.error("[server]", `Webhook delivery to ${sub.url} error:`, err);
  }
}

// ── Server factory ────────────────────────────────────────────────────

function createServer(bot: Bot): McpServer {
  const token = getToken();

  const server = new McpServer(
    { name: "telegram", version: "1.0.0" },
    { capabilities: { extensions: { events: { subscribe: true } } } }
  );

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

  // -- events/list -------------------------------------------------------
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/list"),
      params: z.optional(z.object({ cursor: z.optional(z.string()) })),
    }),
    async () => ({ events: [telegramMessageEvent] })
  );

  // -- events/poll -------------------------------------------------------
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/poll"),
      params: z.object({
        maxEvents: z.optional(z.number()),
        subscriptions: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            params: z.optional(z.record(z.string(), z.unknown())),
            cursor: z.nullable(z.string()),
          })
        ),
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
        return {
          id: sub.id,
          events,
          cursor,
          hasMore: false,
          nextPollSeconds: 5,
        };
      });
      return { results };
    }
  );

  // -- events/stream (push delivery) ------------------------------------
  lowLevel.setRequestHandler(
    z.object({
      method: z.literal("events/stream"),
      params: z.object({
        subscriptions: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            params: z.optional(z.record(z.string(), z.unknown())),
            cursor: z.nullable(z.string()),
          })
        ),
      }),
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
          for (const sub of req.params.subscriptions) {
            activeSubs.delete(sub.id);
          }
          resolve({ _meta: {} });
        });
      });
    }
  );

  // -- events/subscribe (webhook delivery) --------------------------------
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

      if (name !== "telegram.message") {
        throw new Error("EventNotFound");
      }

      const key = webhookKey(delivery.url, id);
      const existing = webhookSubs.get(key);

      if (existing) {
        // Refresh: reset TTL, update mutable fields
        existing.name = name;
        existing.expiresAt = Date.now() + WEBHOOK_TTL_MS;
        if (cursor !== null) existing.cursor = cursor;
        if (delivery.secret) existing.secret = delivery.secret;
        const refreshBefore = new Date(existing.expiresAt).toISOString();
        return { id, cursor: existing.cursor, refreshBefore };
      }

      // New subscription
      const secret = delivery.secret ?? `whsec_${randomBytes(24).toString("base64url")}`;
      const sub: WebhookSub = {
        id,
        name,
        url: delivery.url,
        secret,
        cursor: cursor ?? String(eventSeq),
        expiresAt: Date.now() + WEBHOOK_TTL_MS,
      };
      webhookSubs.set(key, sub);
      console.error("[server]", `Webhook subscription created: ${id} → ${delivery.url}`);

      const refreshBefore = new Date(sub.expiresAt).toISOString();
      return { id, secret, cursor: sub.cursor, refreshBefore };
    }
  );

  // -- events/unsubscribe (webhook delivery) ------------------------------
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
      // Unauthenticated: need delivery.url to form the key
      if (!delivery?.url) {
        throw new Error("delivery.url required for unauthenticated servers");
      }
      const key = webhookKey(delivery.url, id);
      const deleted = webhookSubs.delete(key);
      console.error("[server]", `Webhook unsubscribe ${id}: ${deleted ? "removed" : "not found"}`);
      return {};
    }
  );

  // -- Tools ------------------------------------------------------------

  server.registerTool(
    "reply",
    {
      description: "Send a text message to a chat, with optional threading.",
      inputSchema: {
        chat_id: z.string().describe("Target chat ID"),
        text: z.string().describe("Message text"),
        reply_to: z.string().optional().describe("Message ID to thread under"),
        format: z
          .enum(["text", "markdownv2"])
          .optional()
          .describe("Rendering mode. Default: text"),
      },
    },
    async ({ chat_id, text, reply_to, format }) => {
      const parseMode =
        format === "markdownv2" ? ("MarkdownV2" as const) : undefined;
      const sent = await bot.api.sendMessage(chat_id, text, {
        ...(reply_to
          ? { reply_parameters: { message_id: Number(reply_to) } }
          : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return {
        content: [
          { type: "text" as const, text: `sent (id: ${sent.message_id})` },
        ],
      };
    }
  );

  server.registerTool(
    "react",
    {
      description:
        "Add an emoji reaction to a message. Telegram only accepts its fixed emoji whitelist.",
      inputSchema: {
        chat_id: z.string().describe("Chat ID"),
        message_id: z.string().describe("Message ID to react to"),
        emoji: z.string().describe("Emoji to react with"),
      },
    },
    async ({ chat_id, message_id, emoji }) => {
      await bot.api.setMessageReaction(chat_id, Number(message_id), [
        { type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] },
      ]);
      return { content: [{ type: "text" as const, text: "reacted" }] };
    }
  );

  server.registerTool(
    "download_attachment",
    {
      description:
        "Download a file attachment from Telegram. Returns the download URL. Telegram caps bot downloads at 20MB.",
      inputSchema: {
        file_id: z.string().describe("The file_id from the inbound message"),
      },
    },
    async ({ file_id }) => {
      const file = await bot.api.getFile(file_id);
      if (!file.file_path)
        throw new Error(
          "Telegram returned no file_path — file may have expired"
        );
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      return { content: [{ type: "text" as const, text: url }] };
    }
  );

  server.registerTool(
    "edit_message",
    {
      description:
        "Edit a message the bot previously sent. Edits don't trigger push notifications.",
      inputSchema: {
        chat_id: z.string().describe("Chat ID"),
        message_id: z.string().describe("Message ID to edit"),
        text: z.string().describe("New text"),
        format: z
          .enum(["text", "markdownv2"])
          .optional()
          .describe("Rendering mode. Default: text"),
      },
    },
    async ({ chat_id, message_id, text, format }) => {
      const parseMode =
        format === "markdownv2" ? ("MarkdownV2" as const) : undefined;
      const edited = await bot.api.editMessageText(
        chat_id,
        Number(message_id),
        text,
        ...(parseMode ? [{ parse_mode: parseMode }] : [])
      );
      const id = typeof edited === "object" ? edited.message_id : message_id;
      return {
        content: [{ type: "text" as const, text: `edited (id: ${id})` }],
      };
    }
  );

  return server;
}

// ── Grammy → emit events (buffer + push) ──────────────────────────────

function emitTelegramEvent(ctx: Context): void {
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

  // Store in ring buffer for poll delivery
  bufferEvent(event);

  // Push to active stream subscriptions
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
        console.error(
          "[server]",
          `Failed to push event to sub ${active.id}:`,
          err
        );
      });
  }

  // Deliver to webhook subscriptions
  pruneExpiredWebhooks();
  for (const [, sub] of webhookSubs) {
    if (sub.name !== "telegram.message") continue;
    deliverWebhook(sub, event).catch(() => {});
  }
}

// ── Transport setup ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = getToken();
  const bot = new Bot(token);
  const useHttp = process.argv.includes("--http");

  bot.on("message:text", (ctx) => emitTelegramEvent(ctx));
  bot.on("message:photo", (ctx) => emitTelegramEvent(ctx));
  bot.on("message:document", (ctx) => emitTelegramEvent(ctx));

  bot.catch((err) => {
    console.error(
      "[server]",
      "Grammy handler error (polling continues):",
      err.error
    );
  });

  if (useHttp) {
    const port = parseInt(process.env.PORT ?? "3000", 10);
    const app = createMcpExpressApp();
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      try {
        let transport: StreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) delete transports[sid];
          };
          await createServer(bot).connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        } else {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session" },
            id: null,
          });
          return;
        }
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    });

    app.listen(port, () => {
      console.log(
        `[server] Telegram MCP HTTP server listening on http://127.0.0.1:${port}/mcp`
      );
    });
  } else {
    const server = createServer(bot);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[server]", "Telegram MCP server running on stdio");
  }

  console.error("[server]", "Starting Telegram bot polling...");
  bot
    .start({
      onStart: (info) => {
        console.error(
          "[server]",
          `Telegram bot polling as @${info.username}`
        );
      },
    })
    .catch((err) => {
      console.error("[server]", "Grammy bot.start() failed:", err);
    });
}

main().catch((err) => {
  console.error("[server]", "Fatal:", err);
  process.exit(1);
});
