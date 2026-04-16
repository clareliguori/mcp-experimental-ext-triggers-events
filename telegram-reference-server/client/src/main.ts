import "./env.js";
import { createInterface } from "node:readline";
import { Agent, McpClient } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createModel } from "./model.js";
import {
  startPushDelivery,
  startPollDelivery,
  startWebhookDelivery,
} from "./events.js";

function question(
  rl: ReturnType<typeof createInterface>,
  prompt: string
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

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

  // Connect to the time MCP server for time-related queries
  const timeTransport = new StdioClientTransport({
    command: "uvx",
    args: ["mcp-server-time"],
  });
  const timeClient = new McpClient({ transport: timeTransport });
  await timeClient.connect();

  // Event queue — shared across all delivery modes
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

  // Start the chosen delivery mode
  const client = mcpClient.client;
  if (usePoll) {
    startPollDelivery(client, enqueueMessage);
  } else if (useWebhook) {
    await startWebhookDelivery(client, enqueueMessage);
  } else {
    startPushDelivery(client, enqueueMessage);
  }

  const model = createModel();

  const agent = new Agent({
    model,
    tools: [mcpClient, timeClient],
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
  await timeClient.disconnect();
  await mcpClient.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
