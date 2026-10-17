// src/server.ts: P1 stub (GET /api/health only). WP-WEB replaces this file.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cfg } from "./config.js";

const versionFile = resolve(process.cwd(), "VERSION");
const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "dev";

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url ?? "").split("?")[0] === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(cfg.port, () => console.log(`holdout stub listening on ${cfg.port} (version ${version})`));
