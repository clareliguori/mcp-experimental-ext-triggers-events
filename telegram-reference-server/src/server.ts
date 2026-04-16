#!/usr/bin/env node
/**
 * Telegram MCP Server — exposes Telegram Bot API operations as MCP tools
 * and inbound Telegram messages as MCP Events (push, poll, and webhook delivery).
 *
 * Supports stdio (default) and HTTP (--http) transports.
 * Uses Grammy for Telegram Bot API interactions.
 * Requires TELEGRAM_BOT_TOKEN env var.
 */
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import { getToken } from "./env.js";
import { registerTools } from "./tools.js";
import { registerEventHandlers, emitTelegramEvent } from "./events.js";

function createServer(bot: Bot): McpServer {
  const token = getToken();
  const server = new McpServer(
    { name: "telegram", version: "1.0.0" },
    { capabilities: { extensions: { events: { subscribe: true } } } }
  );

  registerEventHandlers(server);
  registerTools(server, bot, token);

  return server;
}

async function main(): Promise<void> {
  const token = getToken();
  const bot = new Bot(token);
  const useHttp = process.argv.includes("--http");

  bot.on("message:text", (ctx) => emitTelegramEvent(ctx));
  bot.on("message:photo", (ctx) => emitTelegramEvent(ctx));
  bot.on("message:document", (ctx) => emitTelegramEvent(ctx));

  bot.catch((err) => {
    console.error("[server]", "Grammy handler error (polling continues):", err.error);
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
        console.error("[server]", `Telegram bot polling as @${info.username}`);
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
