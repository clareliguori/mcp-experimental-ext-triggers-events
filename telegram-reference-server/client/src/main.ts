import * as readline from "readline-sync";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, BedrockModel, McpClient } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Load .env from current dir or parent dir (for running via `cd client && node`)
for (const dir of [".", ".."]) {
  try {
    for (const line of readFileSync(resolve(dir, ".env"), "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* missing file is fine */ }
}

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http");
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

  const model = new BedrockModel({
    modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  });

  const agent = new Agent({
    model,
    tools: [mcpClient],
    systemPrompt:
      "You are a helpful assistant with access to Telegram. " +
      "Use the available tools to interact with Telegram when asked.",
  });

  console.log('Chat with the assistant (type "quit" to stop)\n');

  while (true) {
    const input = readline.question("You: ").trim();
    if (!input) continue;
    if (["quit", "exit", "/quit", "/exit"].includes(input.toLowerCase())) break;

    try {
      process.stdout.write("\nAssistant: ");
      await agent.invoke(input);
      process.stdout.write("\n");
    } catch (err) {
      console.error(`\nError: ${err}`);
    }
  }

  await mcpClient.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
