import config from "./config.js";
import * as detections from "./detections.js";
import * as serverRegistry from "./serverRegistry.js";
import { broadcast } from "./websocket.js";
import { createLogger } from "./logger.js";

const log = createLogger("cleanup");

let timer = null;

export function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const now = Date.now();

      // 1. Expire old boss spots.
      for (const record of detections.pruneExpired(now)) {
        broadcast("boss_despawned", {
          eventId: record.eventId,
          jobId: record.jobId,
          placeId: record.placeId,
          bossId: record.boss?.id,
          reason: "expired",
        });
      }

      // 2. Drop silent servers and their remaining spots.
      for (const server of serverRegistry.pruneSilent(now)) {
        log.info("server offline:", server.jobId);
        broadcast("server_offline", { jobId: server.jobId, placeId: server.placeId });
        let removed = 0;
        for (const spot of detections.list({ limit: 500 })) {
          if (spot.jobId === server.jobId) {
            detections.remove(spot.eventId);
            removed += 1;
            broadcast("boss_despawned", {
              eventId: spot.eventId,
              jobId: spot.jobId,
              placeId: spot.placeId,
              bossId: spot.boss?.id,
              reason: "server_offline",
            });
          }
        }
        if (removed > 0) log.info(`removed ${removed} spots from offline server ${server.jobId}`);
      }
    } catch (err) {
      log.error("cleanup pass failed:", err.message);
    }
  }, config.cleanupIntervalMs);
  log.info(`cleanup running every ${config.cleanupIntervalMs}ms`);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
