import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, BedrockModel, McpClient } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import type { Model } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { z } from "zod";

// Load .env from current dir or parent dir
for (const dir of [".", ".."]) {
  try {
    for (const line of readFileSync(resolve(dir, ".env"), "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* missing file is fine */
  }
}

function question(
  rl: ReturnType<typeof createInterface>,
  prompt: string
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

// ── Poll result schema ────────────────────────────────────────────────

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

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http");
  const usePoll = process.argv.includes("--poll");
  const useWebhook = process.argv.includes("--webhook");
  const serverUrl = process.env.MCP_SERVER_URL ?? "http://127.0.0.1:3000/mcp";

  let transport: Transport;
  if (useHttp) {
    transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  } else {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("TELEGRAM_BOT_TOKEN env var is required for stdio mode");
      process.exit(1);
    }
    transport = new StdioClientTransport({
      command: "node",
      args: ["./dist/server.js"],
      env: { ...process.env, TELEGRAM_BOT_TOKEN: token },
    });
  }

  const mcpClient = new McpClient({ transport });
  await mcpClient.connect();

  // Queue for incoming Telegram messages
  const eventQueue: string[] = [];
  let resolveWaiting: ((value: string) => void) | null = null;

  function enqueueMessage(msg: string): void {
    if (resolveWaiting) {
      const r = resolveWaiting;
      resolveWaiting = null;
      r(msg);
    } else {
      eventQueue.push(msg);
    }
  }

  function formatEvent(data: Record<string, unknown>): string {
    return `[Telegram event] Message from user ${data.user} in chat_id ${data.chat_id} (message_id ${data.message_id}): ${data.text}`;
  }

  const client = mcpClient.client;

  if (usePoll) {
    // ── Poll-based delivery ──────────────────────────────────────────
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
                  {
                    id: "sub_telegram",
                    name: "telegram.message",
                    cursor,
                  },
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
              enqueueMessage(msg);
            }
          }
          console.error(`[poll] cursor=${cursor} events=${totalEvents}`);
        } catch (err) {
          console.error("Poll error:", err);
        }
        await new Promise((r) => setTimeout(r, pollInterval * 1000));
      }
    })();

    // Cleanup on exit
    process.on("beforeExit", () => {
      polling = false;
    });
  } else if (useWebhook) {
    // ── Webhook-based delivery ───────────────────────────────────────
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

    const SubscribeResultSchema = z.object({
      id: z.string(),
      secret: z.optional(z.string()),
      cursor: z.string(),
      refreshBefore: z.string(),
    });

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

    // Refresh loop — re-subscribe at half the TTL
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
    // Ensure table exists (receiver may not have started yet)
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
      /* readonly mode — table will exist once receiver starts */
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
            enqueueMessage(msg);
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
  } else {
    // ── Push-based delivery ──────────────────────────────────────────
    console.log("📡 Using push-based event delivery\n");

    client.fallbackNotificationHandler = async (
      notification: Notification
    ) => {
      if (notification.method === "notifications/events/event") {
        const p = notification.params as Record<string, unknown>;
        const data = p.data as Record<string, unknown>;
        const msg = formatEvent(data);
        console.log(`\n📨 ${msg}`);
        enqueueMessage(msg);
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

  const provider = process.env.MODEL_PROVIDER ?? "bedrock";
  let model: Model;
  switch (provider) {
    case "anthropic":
      model = new AnthropicModel({
        modelId: process.env.MODEL_ID ?? "claude-sonnet-4-6",
      });
      console.log(`Using Anthropic (${(model as AnthropicModel).getConfig().modelId})`);
      break;
    case "openai":
      model = new OpenAIModel({
        api: "chat",
        modelId: process.env.MODEL_ID ?? "gpt-5.4",
      });
      console.log(`Using OpenAI (${(model as OpenAIModel).getConfig().modelId})`);
      break;
    default:
      model = new BedrockModel({
        modelId: process.env.MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
      });
      console.log(`Using Bedrock (${(model as BedrockModel).getConfig().modelId})`);
      break;
  }

  const agent = new Agent({
    model,
    tools: [mcpClient],
    systemPrompt:
      "You are a helpful assistant. You chat directly with the user in this terminal. " +
      "You are also connected to Telegram. Messages prefixed with [Telegram event] are from Telegram users — " +
      "use the reply tool with the provided chat_id to respond to them. " +
      "Messages without that prefix are from the terminal user — respond directly in text.",
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Chat with the assistant (type "quit" to stop)');
  console.log("Telegram messages will be fed to the agent automatically.\n");

  function nextInput(): Promise<string> {
    const queued = eventQueue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve) => {
      resolveWaiting = resolve;
      question(rl, "You: ").then((answer) => {
        if (resolveWaiting === resolve) {
          resolveWaiting = null;
        }
        resolve(answer);
      });
    });
  }

  while (true) {
    const input = (await nextInput()).trim();
    if (!input) continue;
    if (["quit", "exit", "/quit", "/exit"].includes(input.toLowerCase())) break;

    try {
      process.stdout.write("\nAssistant: ");
      await agent.invoke(input);
      process.stdout.write("\n\n");
    } catch (err) {
      console.error(`\nError: ${err}`);
    }
  }

  rl.close();
  await mcpClient.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
