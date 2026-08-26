import crypto from "node:crypto";
import fs from "node:fs";

import config from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("auth");

// ── Timing-safe comparison ───────────────────────────────────────────────
export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ── Producer auth (Bearer INGEST_TOKEN) ──────────────────────────────────
export function requireIngest(req, res, next) {
  const header = req.headers.authorization || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!constantTimeEqual(header.slice(prefix.length), config.ingestToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Admin sessions (token never lives in client-side JS) ────────────────
const sessions = new Map(); // sessionId -> expiresAtMs
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createAdminSession() {
  const id = crypto.randomUUID();
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
}

export function destroyAdminSession(id) {
  sessions.delete(id);
}

export function isValidAdminSession(id) {
  const expiresAt = sessions.get(id);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(id);
    return false;
  }
  return true;
}

export function requireAdmin(req, res, next) {
  // Header path (scripts/curl) or cookie path (dashboard).
  const headerToken = req.headers["x-admin-token"];
  if (headerToken && constantTimeEqual(headerToken, config.adminToken)) {
    return next();
  }
  const cookie = req.headers.cookie || "";
  const match = /(?:^|;\s*)afs_admin=([A-Za-z0-9-]+)/.exec(cookie);
  if (match && isValidAdminSession(match[1])) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── User keys (finder clients) ───────────────────────────────────────────
const keyDb = new Map(); // key -> { userIds:Set, createdAt, plan, note }

function saveKeyDb() {
  try {
    const data = {};
    for (const [key, entry] of keyDb) {
      data[key] = {
        userIds: [...entry.userIds],
        createdAt: entry.createdAt,
        plan: entry.plan,
        note: entry.note,
      };
    }
    fs.writeFileSync(config.keyDbFile, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error("failed to save key db:", err.message);
  }
}

function loadKeyDb() {
  try {
    if (fs.existsSync(config.keyDbFile)) {
      const data = JSON.parse(fs.readFileSync(config.keyDbFile, "utf8"));
      for (const [key, entry] of Object.entries(data)) {
        keyDb.set(key, {
          userIds: new Set(entry.userIds || []),
          createdAt: entry.createdAt || Date.now(),
          plan: entry.plan || "free",
          note: entry.note || "",
        });
      }
    }
  } catch (err) {
    log.error("failed to load key db:", err.message);
  }
}

loadKeyDb();

// Seed a demo key so the system works out of the box.
if (!keyDb.has("AFS-WORLD-DEMO-7K3X")) {
  keyDb.set("AFS-WORLD-DEMO-7K3X", {
    userIds: new Set(),
    createdAt: Date.now(),
    plan: "free",
    note: "demo world boss joiner key",
  });
  saveKeyDb();
}

export function isValidKey(key) {
  return typeof key === "string" && key.length >= 8 && keyDb.has(key);
}

export function getKeyInfo(key) {
  const entry = keyDb.get(key);
  if (!entry) return null;
  return { plan: entry.plan, note: entry.note, createdAt: entry.createdAt };
}

export function listKeys() {
  return [...keyDb.entries()].map(([key, entry]) => ({
    key,
    userIds: [...entry.userIds],
    createdAt: entry.createdAt,
    plan: entry.plan,
    note: entry.note,
  }));
}

export function addKey(key, { plan = "free", note = "", userIds = [] } = {}) {
  if (typeof key !== "string" || key.length < 8) return false;
  keyDb.set(key, {
    userIds: new Set(userIds.map(String)),
    createdAt: Date.now(),
    plan,
    note,
  });
  saveKeyDb();
  return true;
}

export function removeKey(key) {
  if (!keyDb.delete(key)) return false;
  saveKeyDb();
  return true;
}

// Finder clients authenticate with x-access-key (REST) or ?key= (WebSocket).
export function requireKey(req, res, next) {
  const key = req.headers["x-access-key"] || req.query.key;
  if (!isValidKey(key)) {
    return res.status(401).json({ error: "Invalid access key" });
  }
  req.accessKey = key;
  next();
}
