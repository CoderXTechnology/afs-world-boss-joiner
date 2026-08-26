// POSTs a fake world boss spotting to /api/spot so you can test the
// backend, dashboard and WebSocket feed without waiting for a real spawn.
//
//   INGEST_TOKEN=... npm run simulate
//   SIM_BOSS=SeaBeast SIM_JOB_ID=test-job-1 npm run simulate
//
import config from "../src/config.js";

const BASE_URL = process.env.BASE_URL || `http://localhost:${config.port}`;

const bossId = process.env.SIM_BOSS || "SeaBeast";
const rarity = process.env.SIM_RARITY || "world";
const jobId = process.env.SIM_JOB_ID || `sim-${Math.random().toString(16).slice(2, 10)}`;
const placeId = Number(process.env.SIM_PLACE_ID) || 122385531796312;

const payload = {
  eventId: `${jobId}:${bossId}:sim`,
  placeId,
  jobId,
  boss: {
    id: bossId,
    name: bossId.replace(/([a-z])([A-Z])/g, "$1 $2"),
    rarity,
    variant: "Normal",
    level: 0,
    maxHealth: 8500,
    entityId: 999999,
  },
  players: 3,
  maxPlayers: 12,
  detectedAt: Date.now(),
};

const res = await fetch(`${BASE_URL}/api/spot`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.ingestToken}`,
  },
  body: JSON.stringify(payload),
});

console.log("POST", `${BASE_URL}/api/spot`, "→", res.status);
console.log(JSON.stringify(payload, null, 2));
const body = await res.text();
console.log("response:", body);
