import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bot } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import { z } from "zod";

export function registerTools(server: McpServer, bot: Bot, token: string): void {
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
      return {
        content: [
          {
            type: "text" as const,
            text: `https://api.telegram.org/file/bot${token}/${file.file_path}`,
          },
        ],
      };
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
}
