import config from "./config.js";

// Tracks which Roblox server instances (jobIds) are alive, based on the
// heartbeats their producer scripts send every ~25 seconds.
const servers = new Map(); // jobId -> { placeId, players, maxPlayers, startedAt, lastSeen }

export function touch({ placeId, jobId, players, maxPlayers, startedAt }, now = Date.now()) {
  const existing = servers.get(jobId);
  const record = {
    placeId,
    jobId,
    players,
    maxPlayers,
    startedAt: startedAt || existing?.startedAt || now,
    lastSeen: now,
  };
  servers.set(jobId, record);
  return { isNew: !existing, record };
}

export function remove(jobId) {
  return servers.delete(jobId);
}

export function get(jobId) {
  return servers.get(jobId) || null;
}

export function isOnline(jobId, now = Date.now()) {
  const record = servers.get(jobId);
  if (!record) return false;
  return now - record.lastSeen <= config.serverTtlMs;
}

export function list(now = Date.now()) {
  return [...servers.values()]
    .filter((record) => now - record.lastSeen <= config.serverTtlMs)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

// Drops silent servers; returns them so the caller can broadcast
// server_offline (and expire that server's spots).
export function pruneSilent(now = Date.now()) {
  const offline = [];
  for (const [jobId, record] of servers) {
    if (now - record.lastSeen > config.serverTtlMs) {
      offline.push(record);
      servers.delete(jobId);
    }
  }
  return offline;
}

export function stats(now = Date.now()) {
  const online = list(now);
  return {
    online: online.length,
    players: online.reduce((sum, record) => sum + (record.players || 0), 0),
  };
}
