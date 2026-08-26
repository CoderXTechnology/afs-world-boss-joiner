import express from "express";

import { requireIngest } from "../auth.js";
import * as detections from "../detections.js";
import { broadcast } from "../websocket.js";

const router = express.Router();

// POST /api/despawn — a producer reports that a boss is gone (killed,
// despawned, or the reporting script shut down).
router.post("/", requireIngest, (req, res) => {
  const data = req.body;
  if (!data || typeof data.eventId !== "string" || data.eventId.length < 8 || data.eventId.length > 128) {
    return res.status(400).json({ error: "Invalid eventId" });
  }

  const record = detections.get(data.eventId);
  const removed = detections.remove(data.eventId);

  if (removed) {
    broadcast("boss_despawned", {
      eventId: data.eventId,
      jobId: record.jobId,
      placeId: record.placeId,
      bossId: record.boss?.id,
      reason: data.reason || "despawned",
    });
  }

  // Idempotent: despawning an unknown event is not an error.
  return res.json({ ok: true, removed });
});

export default router;
