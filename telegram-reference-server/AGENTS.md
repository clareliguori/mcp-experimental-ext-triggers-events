# AGENTS.md

## Project Overview

Telegram MCP Server — exposes Telegram Bot API operations as MCP tools. Supports dual transport: stdio (default) and Streamable HTTP (`--http` flag). Uses Grammy for Telegram Bot API interactions. Includes a minimal chatbot client using Strands Agents SDK.

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

### Client
- Uses `@strands-agents/sdk` `Agent` with `BedrockModel` (Claude Sonnet) and `McpClient`.
- Supports stdio (default, spawns server) and HTTP (`--http`, connects to running server).
- Interactive REPL loop with `readline-sync`.

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
npm run client:start:http    # HTTP (connect to running server)
```
