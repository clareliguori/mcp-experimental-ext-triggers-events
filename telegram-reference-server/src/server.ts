#!/usr/bin/env node
/**
 * Telegram MCP Server — exposes Telegram Bot API operations as MCP tools.
 * Supports stdio (default) and HTTP (--http) transports.
 *
 * Uses Grammy for Telegram Bot API interactions.
 * Requires TELEGRAM_BOT_TOKEN env var.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Bot } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import { z } from "zod";

// Load .env if present (shell env takes precedence)
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* missing file is fine */ }

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN env var is required");
    process.exit(1);
  }
  return token;
}

function createServer(): McpServer {
  const token = getToken();
  const bot = new Bot(token);

  const server = new McpServer({
    name: "telegram",
    version: "1.0.0",
  });

  server.registerTool(
    "reply",
    {
      description:
        "Send a text message to a chat, with optional threading.",
      inputSchema: {
        chat_id: z.string().describe("Target chat ID"),
        text: z.string().describe("Message text"),
        reply_to: z
          .string()
          .optional()
          .describe("Message ID to thread under"),
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
        content: [{ type: "text" as const, text: `sent (id: ${sent.message_id})` }],
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
      const id =
        typeof edited === "object" ? edited.message_id : message_id;
      return {
        content: [{ type: "text" as const, text: `edited (id: ${id})` }],
      };
    }
  );

  return server;
}

async function main(): Promise<void> {
  // Validate token at startup, not per-session
  getToken();

  const useHttp = process.argv.includes("--http");

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
          await createServer().connect(transport);
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
        `Telegram MCP HTTP server listening on http://127.0.0.1:${port}/mcp`
      );
    });
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Telegram MCP server running on stdio");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
