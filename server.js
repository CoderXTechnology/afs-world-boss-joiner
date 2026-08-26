import http from "node:http";

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import config from "./config.js";
import { createLogger } from "./logger.js";
import * as websocket from "./websocket.js";
import * as cleanup from "./cleanup.js";

import healthRoutes from "./routes/health.js";
import spotRoutes from "./routes/spot.js";
import despawnRoutes from "./routes/despawn.js";
import heartbeatRoutes from "./routes/heartbeat.js";
import spotsRoutes from "./routes/spots.js";
import statsRoutes from "./routes/stats.js";
import adminRoutes from "./routes/admin.js";

const log = createLogger("server");

const app = express();
app.use(helmet());
app.set("trust proxy", 1); // behind Railway's proxy
app.use(express.json({ limit: "64kb" }));

// Basic abuse guard on the public-facing write endpoints.
const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.use("/health", healthRoutes);
app.use("/api/spot", writeLimiter, spotRoutes);
app.use("/api/despawn", writeLimiter, despawnRoutes);
app.use("/api/heartbeat", writeLimiter, heartbeatRoutes);
app.use("/api/spots", spotsRoutes);
app.use("/api/stats", statsRoutes);
app.use("/admin", adminRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  log.error("unhandled:", err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: "Internal error" });
});

const server = http.createServer(app);
websocket.init(server);
cleanup.start();

server.listen(config.port, "0.0.0.0", () => {
  log.info(`listening on 0.0.0.0:${config.port} (${config.nodeEnv})`);
});

// Graceful shutdown so Railway restarts don't drop clients rudely.
function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  cleanup.stop();
  websocket.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
