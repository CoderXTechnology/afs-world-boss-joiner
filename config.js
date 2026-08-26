// Central configuration, parsed once from environment variables.
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 8080),

  ingestToken: process.env.INGEST_TOKEN || "",
  adminToken: process.env.ADMIN_TOKEN || "",

  spotTtlMs: num(process.env.SPOT_TTL_SECONDS, 90) * 1000,
  serverTtlMs: num(process.env.SERVER_TTL_SECONDS, 120) * 1000,
  maxSpots: num(process.env.MAX_SPOTS, 1000),

  keyDbFile: process.env.KEY_DB_FILE || "./keys.json",

  // Heartbeats are expected every ~25s; anything past the TTL is offline.
  cleanupIntervalMs: 5000,
  wsPingIntervalMs: 15000,
};

if (config.nodeEnv === "production" && (!config.ingestToken || !config.adminToken)) {
  // Throwing here is intentional: Railway restarts the deploy until the
  // variables are set, which is better than running an open endpoint.
  throw new Error("INGEST_TOKEN and ADMIN_TOKEN are required in production");
}
if (!config.ingestToken) config.ingestToken = "dev-ingest-token";
if (!config.adminToken) config.adminToken = "dev-admin-token";

export default config;
