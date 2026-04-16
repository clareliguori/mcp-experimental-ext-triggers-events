import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, BedrockModel, McpClient } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
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
      args: ["../dist/server.js"],
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

  const model = new BedrockModel({
    modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  });

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
