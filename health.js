import express from "express";

import * as detections from "../detections.js";
import * as serverRegistry from "../serverRegistry.js";
import { clientCount } from "../websocket.js";

const router = express.Router();

// Railway healthcheck target. No auth — exposes nothing sensitive.
router.get("/", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    detections: detections.stats(),
    servers: serverRegistry.stats(),
    wsConnections: clientCount(),
  });
});

export default router;
