import express from "express";

import { requireKey } from "../auth.js";
import * as detections from "../detections.js";
import * as serverRegistry from "../serverRegistry.js";
import { clientCount } from "../websocket.js";

const router = express.Router();

// GET /api/stats?key=... — small summary for finder clients.
router.get("/", requireKey, (req, res) => {
  res.json({
    ok: true,
    ...detections.stats(),
    servers: serverRegistry.stats(),
    wsConnections: clientCount(),
    serverTime: Date.now(),
  });
});

export default router;
