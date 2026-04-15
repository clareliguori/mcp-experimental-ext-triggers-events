# Telegram MCP Server

MCP server that exposes Telegram Bot API operations as tools. Supports stdio and HTTP transports.

## Setup

### 1. Create a bot with BotFather

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for:

- **Name** — display name shown in chat headers (anything, can contain spaces)
- **Username** — unique handle ending in `bot` (e.g. `my_assistant_bot`)

BotFather replies with a token like `123456789:AAHfiqksKZ8...` — copy the whole thing including the leading number and colon.

### 2. Install and build

```bash
npm install
npm run build
```

## Usage

First, set `TELEGRAM_BOT_TOKEN` in an `.env` file:

```bash
echo "TELEGRAM_BOT_TOKEN=123456789:AAHfiqksKZ8..." > .env
```

You can also set the `TELEGRAM_BOT_TOKEN` env var in your environment.

### Start stdio server (default)

```bash
node dist/server.js
```

### Start HTTP server

```bash
node dist/server.js --http
# Listens on http://127.0.0.1:3000/mcp
# Set PORT env var to change the port.
```

### MCP client config (stdio)

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "<your-token>"
      }
    }
  }
}
```

### MCP client config (HTTP)

```json
{
  "mcpServers": {
    "telegram": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a text message to a chat, with optional threading |
| `react` | Add an emoji reaction to a message |
| `download_attachment` | Download a file attachment, returns URL |
| `edit_message` | Edit a previously sent message |

## Client (Strands Agents SDK)

A minimal interactive chatbot that connects to the server via stdio and routes tool calls through a Bedrock-hosted LLM.

```bash
npm run client:install && npm run client:build
```

### stdio (default — spawns the server automatically)

```bash
npm run client:start
```

### HTTP (connect to an already-running server)

Start the server in one terminal:
```bash
node dist/server.js --http
```

Then run the client in another:
```bash
npm run client:start:http
# Connects to http://127.0.0.1:3000/mcp by default.
# Set MCP_SERVER_URL to override.
```

Requires AWS credentials configured for Bedrock access.

## Notes

- Telegram's Bot API exposes **no message history or search**. The bot only sees messages as they arrive. If you need earlier context, ask the user to paste or summarize.
- Telegram only accepts a [fixed whitelist of emoji](https://core.telegram.org/bots/api#reactiontypeemoji) for reactions — non-whitelisted emoji will be rejected.
- Telegram caps bot file downloads at 20MB.
