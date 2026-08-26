import { WebSocketServer } from "ws";

import config from "./config.js";
import { isValidKey } from "./auth.js";
import { createLogger } from "./logger.js";

const log = createLogger("ws");

let wss = null;
let pingTimer = null;

// Auth happens on the upgrade request: finder clients pass ?key=<user key>,
// the admin dashboard may pass ?admin=<ADMIN_TOKEN> (used by external tools).
function authorizeUpgrade(req) {
  const url = new URL(req.url, "http://localhost");
  const key = url.searchParams.get("key");
  if (key && isValidKey(key)) return { kind: "client", key };
  const admin = url.searchParams.get("admin");
  if (admin && admin === config.adminToken) return { kind: "admin" };
  return null;
}

export function init(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (socket, req) => {
    const auth = authorizeUpgrade(req);
    if (!auth) {
      socket.close(4401, "Unauthorized");
      return;
    }
    socket.isAlive = true;
    socket.auth = auth;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("error", (err) => log.warn("socket error:", err.message));
    socket.on("close", () => log.debug("client disconnected"));

    socket.send(
      JSON.stringify({
        type: "hello",
        data: { kind: auth.kind, serverTime: Date.now() },
      })
    );
  });

  pingTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, config.wsPingIntervalMs);

  log.info("websocket server ready on /ws");
}

export function broadcast(type, data) {
  if (!wss) return;
  const payload = JSON.stringify({ type, data, ts: Date.now() });
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

export function clientCount() {
  if (!wss) return 0;
  let count = 0;
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) count += 1;
  }
  return count;
}

export function close() {
  if (pingTimer) clearInterval(pingTimer);
  if (wss) {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  }
}
