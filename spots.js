import express from "express";

import { requireKey } from "../auth.js";
import * as detections from "../detections.js";

const router = express.Router();

// GET /api/spots?key=... — live boss spots for finder clients.
// Query params: boss=<substring>, maxAge=<seconds>, limit=<n>
router.get("/", requireKey, (req, res) => {
  const { boss, maxAge, limit } = req.query;

  const maxAgeMs = maxAge != null ? Number(maxAge) * 1000 : null;
  const parsedLimit = Math.min(Number(limit) || 200, 500);

  const spots = detections.list({
    boss: boss || undefined,
    maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : null,
    limit: parsedLimit,
  });

  res.json({ spots, count: spots.length });
});

export default router;
