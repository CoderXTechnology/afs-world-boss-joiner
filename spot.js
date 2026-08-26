import express from "express";

import config from "../config.js";
import { requireIngest } from "../auth.js";
import * as detections from "../detections.js";
import * as serverRegistry from "../serverRegistry.js";
import { broadcast } from "../websocket.js";

const router = express.Router();

const isStr = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// POST /api/spot — a producer reports a world boss spawn.
router.post("/", requireIngest, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Invalid body" });
  }

  // ── Identity ───────────────────────────────────────────────────────────
  if (!isStr(data.eventId, 8, 128)) {
    return res.status(400).json({ error: "Invalid eventId" });
  }
  if (!isStr(data.jobId, 8, 64)) {
    return res.status(400).json({ error: "Invalid jobId" });
  }
  if (!isInt(data.placeId, 1, 2 ** 53)) {
    return res.status(400).json({ error: "Invalid placeId" });
  }

  // ── Boss payload ───────────────────────────────────────────────────────
  const boss = data.boss;
  if (!boss || typeof boss !== "object") {
    return res.status(400).json({ error: "Invalid boss" });
  }
  if (!isStr(boss.id, 1, 64) || !isStr(boss.name, 1, 64)) {
    return res.status(400).json({ error: "Invalid boss id/name" });
  }
  if (boss.rarity != null && !isStr(boss.rarity, 1, 32)) {
    return res.status(400).json({ error: "Invalid boss rarity" });
  }
  if (boss.variant != null && !isStr(boss.variant, 1, 32)) {
    return res.status(400).json({ error: "Invalid boss variant" });
  }
  if (boss.level != null && !isInt(boss.level, 0, 10 ** 9)) {
    return res.status(400).json({ error: "Invalid boss level" });
  }
  if (boss.maxHealth != null && !(typeof boss.maxHealth === "number" && boss.maxHealth >= 0)) {
    return res.status(400).json({ error: "Invalid boss maxHealth" });
  }

  // ── Server population ──────────────────────────────────────────────────
  if (!isInt(data.players, 0, 1000) || !isInt(data.maxPlayers, 1, 1000)) {
    return res.status(400).json({ error: "Invalid player counts" });
  }

  // ── Freshness ──────────────────────────────────────────────────────────
  const now = Date.now();
  const detectedAt = Number(data.detectedAt);
  if (!Number.isFinite(detectedAt)) {
    return res.status(400).json({ error: "Invalid detectedAt" });
  }
  if (detectedAt > now + 30_000) {
    return res.status(400).json({ error: "detectedAt is in the future" });
  }
  if (now - detectedAt > config.spotTtlMs * 2) {
    return res.status(400).json({ error: "Detection too stale" });
  }

  // ── Dedupe ─────────────────────────────────────────────────────────────
  if (detections.has(data.eventId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  const { duplicate, record } = detections.add(
    {
      eventId: data.eventId,
      placeId: data.placeId,
      jobId: data.jobId,
      boss: {
        id: boss.id,
        name: boss.name,
        rarity: boss.rarity || "world",
        variant: boss.variant || "Normal",
        level: boss.level ?? 0,
        maxHealth: boss.maxHealth ?? 0,
        entityId: boss.entityId ?? null,
      },
      players: data.players,
      maxPlayers: data.maxPlayers,
      detectedAt,
    },
    now
  );

  if (duplicate) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  broadcast("boss_spotted", record);
  return res.status(201).json({ ok: true });
});

export default router;
