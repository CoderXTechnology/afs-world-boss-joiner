import express from "express";

import { requireIngest } from "../auth.js";
import * as serverRegistry from "../serverRegistry.js";
import { broadcast } from "../websocket.js";

const router = express.Router();

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// POST /api/heartbeat — every producer server pings ~every 25s so the
// backend knows which servers are alive and how full they are.
router.post("/", requireIngest, (req, res) => {
  const data = req.body;
  if (!data || typeof data.jobId !== "string" || data.jobId.length < 8 || data.jobId.length > 64) {
    return res.status(400).json({ error: "Invalid jobId" });
  }
  if (!isInt(data.placeId, 1, 2 ** 53)) {
    return res.status(400).json({ error: "Invalid placeId" });
  }
  if (!isInt(data.players, 0, 1000) || !isInt(data.maxPlayers, 1, 1000)) {
    return res.status(400).json({ error: "Invalid player counts" });
  }

  const { isNew, record } = serverRegistry.touch({
    placeId: data.placeId,
    jobId: data.jobId,
    players: data.players,
    maxPlayers: data.maxPlayers,
    startedAt: Number(data.startedAt) || undefined,
  });

  broadcast(isNew ? "server_online" : "server_updated", record);
  return res.json({ ok: true });
});

export default router;
