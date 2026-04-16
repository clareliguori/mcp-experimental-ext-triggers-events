# Telegram MCP Server

MCP server that exposes Telegram Bot API operations as tools and inbound Telegram messages as MCP Events (push and poll delivery). Supports stdio and HTTP transports.

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

For webhook delivery, also add `WEBHOOK_URL`:

```bash
echo "WEBHOOK_URL=http://localhost:8080/hooks" >> .env
```

The server and client both auto-load `.env` from the working directory (the client also checks the parent directory). You can also set the env var directly.

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

## Events

The server implements the MCP Events design sketch proposal with push delivery. Grammy polls Telegram for inbound messages and pushes them to subscribed clients.

| Event | Delivery | Description |
|-------|----------|-------------|
| `telegram.message` | push, poll | Fires when the bot receives a text, photo, or document message |

Clients subscribe via `events/stream` (push) or `events/poll` (poll). The server confirms push subscriptions with `notifications/events/active` and delivers events as `notifications/events/event` notifications. Poll clients call `events/poll` at the server-recommended interval.

For webhook delivery, clients call `events/subscribe` with a callback URL. The server POSTs events with HMAC-SHA256 signatures (`X-MCP-Signature`, `X-MCP-Timestamp` headers). Subscriptions have a 1-minute TTL (for demo; set longer for production) and must be refreshed before `refreshBefore`.

## Client (Strands Agents SDK)

A minimal interactive chatbot that connects to the server, subscribes to Telegram events, and routes both terminal input and inbound Telegram messages through an LLM agent.

- Terminal messages get a direct text response
- Telegram messages are automatically queued and fed into the agent loop; the agent uses the `reply` tool to respond in the Telegram chat

```bash
npm run client:install && npm run client:build
```

### Model provider

Set `MODEL_PROVIDER` to choose the LLM backend. Override the model with `MODEL_ID`.

| `MODEL_PROVIDER` | Default `MODEL_ID` | Credentials needed |
|---|---|---|
| `bedrock` (default) | `global.anthropic.claude-sonnet-4-6` | AWS credentials |
| `anthropic` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-5.4` | `OPENAI_API_KEY` |

Example:
```bash
MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run client:start
```

### Transport × delivery matrix

| | push (default) | poll (`--poll`) | webhook (`--webhook`) |
|---|---|---|---|
| **stdio** (default) | `npm run client:start` | `npm run client:start:poll` | `npm run client:start:webhook` |
| **HTTP** (`--http`) | `npm run client:start:http` | `npm run client:start:http:poll` | `npm run client:start:http:webhook` |

### stdio (default — spawns the server automatically)

```bash
npm run client:start
```

By default the client uses push delivery (`events/stream`). To use poll delivery instead:

```bash
npm run client:start:poll
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

Or with poll delivery:
```bash
npm run client:start:http:poll
```

## Notes

- Telegram's Bot API exposes **no message history or search**. The bot only sees messages as they arrive. If you need earlier context, ask the user to paste or summarize.
- Telegram only accepts a [fixed whitelist of emoji](https://core.telegram.org/bots/api#reactiontypeemoji) for reactions — non-whitelisted emoji will be rejected.
- Telegram caps bot file downloads at 20MB.
