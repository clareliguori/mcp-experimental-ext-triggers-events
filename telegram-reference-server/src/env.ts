import { readFileSync } from "node:fs";

// Load .env if present (shell env takes precedence)
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* missing file is fine */
}

export function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[server]", "TELEGRAM_BOT_TOKEN env var is required");
    process.exit(1);
  }
  return token;
}
