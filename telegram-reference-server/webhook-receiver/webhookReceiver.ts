#!/usr/bin/env node
/**
 * Webhook receiver — accepts HMAC-signed event POSTs from the MCP server
 * and inserts them into a SQLite database for the client to poll.
 *
 * Usage: node webhookReceiver.js
 * Env: WEBHOOK_PORT (default 8080), WEBHOOK_SECRET, WEBHOOK_DB (default ./webhooks.db)
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import Database from "better-sqlite3";

// Load .env from current dir
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* missing file is fine */
}

const port = parseInt(process.env.WEBHOOK_PORT ?? "8080", 10);
const dbPath = process.env.WEBHOOK_DB ?? "./webhooks.db";
const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error("[webhook] WEBHOOK_SECRET env var is required");
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    payload TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

const insert = db.prepare(
  "INSERT OR IGNORE INTO events (event_id, payload) VALUES (?, ?)"
);

const app = express();
app.use(express.json());

app.post("/hooks", (req, res) => {
  const body = JSON.stringify(req.body);
  const ts = req.headers["x-mcp-timestamp"] as string | undefined;
  const sig = req.headers["x-mcp-signature"] as string | undefined;

  if (!ts || !sig) {
    console.error("[webhook] Missing signature headers");
    res.status(401).send("Missing signature headers");
    return;
  }

  const expected = createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("hex");
  if (sig !== `sha256=${expected}`) {
    console.error("[webhook] HMAC verification failed");
    res.status(401).send("Invalid signature");
    return;
  }

  const eventId = req.body.eventId ?? `unknown_${Date.now()}`;
  insert.run(eventId, body);
  console.error(`[webhook] Stored event ${eventId}`);
  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`[webhook] Receiver listening on http://localhost:${port}/hooks`);
  console.log(`[webhook] Events stored in ${dbPath}`);
});
