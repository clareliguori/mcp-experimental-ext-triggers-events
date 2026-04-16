import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from current dir or parent dir
for (const dir of [".", ".."]) {
  try {
    for (const line of readFileSync(resolve(dir, ".env"), "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* missing file is fine */
  }
}
