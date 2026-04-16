# AGENTS.md

## Project Overview

Telegram MCP Server — exposes Telegram Bot API operations as MCP tools and inbound Telegram messages as MCP Events (push and poll delivery). Supports dual transport: stdio (default) and Streamable HTTP (`--http` flag). Uses Grammy for Telegram Bot API interactions. Includes a minimal chatbot client using Strands Agents SDK.

## Key Folders

- `src/` — TypeScript source. Single-file server at `src/server.ts`.
- `dist/` — Compiled JS output (gitignored).
- `client/` — Minimal chatbot client using Strands Agents SDK + Bedrock.
- `client/src/main.ts` — REPL that connects to the server via stdio or HTTP and exposes tools to an LLM agent.

## Architecture

### Server
- `McpServer` from `@modelcontextprotocol/sdk` registers 4 Telegram tools.
- Uses Grammy `Bot` for all Telegram Bot API calls.
- Both server and client auto-load `.env` from the working directory (client also checks parent dir).
- Transport is selected at startup: `StdioServerTransport` (default) or `StreamableHTTPServerTransport` + Express (`--http`).
- HTTP mode uses `createMcpExpressApp()` from the SDK with session management via `mcp-session-id` header.

### MCP Events (push delivery)
- Implements the Events design sketch proposal (`docs/design-sketch-proposal.md` on `upstream/pja/design-sketch`).
- Declares `events` capability via `extensions`.
- Handles `events/list` — advertises `telegram.message` event with `delivery: ["push","poll"]`.
- Handles `events/stream` — accepts subscriptions, confirms with `notifications/events/active`, delivers events as `notifications/events/event` notifications.
- Handles `events/poll` — returns events since cursor from a ring buffer (max 1000 events), with `nextPollSeconds: 5`.
- Grammy `bot.start()` polls Telegram for inbound messages; `bot.on("message:text" | "message:photo" | "message:document")` handlers emit push events to all active subscriptions.
- Custom notification methods (`notifications/events/*`) are sent via `extra.sendNotification()` with type casting since the SDK doesn't have native events support yet.

### Client
- Uses `@strands-agents/sdk` `Agent` with `BedrockModel` (Claude Sonnet) and `McpClient`.
- Supports stdio (default, spawns server) and HTTP (`--http`, connects to running server).
- Supports push (`events/stream`, default) and poll (`events/poll`, `--poll`) delivery.
- Incoming Telegram messages are queued and fed into the agent loop on the next turn.
- Terminal input and Telegram events are distinguished by a `[Telegram event]` prefix so the agent responds appropriately (direct text vs `reply` tool).
- Interactive async REPL loop with Node `readline`.

## Tools

`reply`, `react`, `download_attachment`, `edit_message`

## Standard Development Workflow

```bash
# Setup: create .env with TELEGRAM_BOT_TOKEN=<token>

# Server — install, build, lint, run
npm install && npm run build && npm run lint
npm start                    # stdio
npm run start:http           # HTTP on port 3000

# Client — install, build, lint, run
npm run client:install && npm run client:build && npm run client:lint
npm run client:start         # stdio (spawns server)
npm run client:start:poll    # stdio + poll delivery
npm run client:start:http    # HTTP (connect to running server)
npm run client:start:http:poll  # HTTP + poll delivery
```
