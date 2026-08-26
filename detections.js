import config from "./config.js";

// In-memory detection registry. Keyed by the deterministic eventId the
// producer builds from jobId:entityType:entityId, so re-reports of the same
// boss dedupe naturally.
const detections = new Map(); // eventId -> detection
let totalSpots = 0;

export function has(eventId) {
  return detections.has(eventId);
}

export function add(detection, now = Date.now()) {
  if (detections.has(detection.eventId)) {
    return { duplicate: true };
  }
  const record = {
    ...detection,
    status: "active",
    receivedAt: now,
    expiresAt: now + config.spotTtlMs,
  };
  detections.set(detection.eventId, record);
  totalSpots += 1;

  // Enforce the cap by evicting the soonest-to-expire entries.
  if (detections.size > config.maxSpots) {
    const sorted = [...detections.values()].sort((a, b) => a.expiresAt - b.expiresAt);
    for (const victim of sorted.slice(0, detections.size - config.maxSpots)) {
      detections.delete(victim.eventId);
    }
  }
  return { duplicate: false, record };
}

export function update(eventId, patch) {
  const record = detections.get(eventId);
  if (!record) return null;
  Object.assign(record, patch);
  record.expiresAt = Date.now() + config.spotTtlMs;
  return record;
}

export function remove(eventId) {
  return detections.delete(eventId);
}

export function get(eventId) {
  return detections.get(eventId) || null;
}

export function list({ boss, maxAgeMs, limit = 200 } = {}) {
  const now = Date.now();
  let results = [...detections.values()];
  if (boss) {
    const needle = String(boss).toLowerCase();
    results = results.filter(
      (d) =>
        (d.boss?.name || "").toLowerCase().includes(needle) ||
        (d.boss?.id || "").toLowerCase().includes(needle)
    );
  }
  if (maxAgeMs != null) {
    results = results.filter((d) => now - d.detectedAt <= maxAgeMs);
  }
  results.sort((a, b) => b.detectedAt - a.detectedAt);
  return results.slice(0, Math.min(limit, 500));
}

// Drops expired detections; returns them so the caller can broadcast
// boss_despawned for each.
export function pruneExpired(now = Date.now()) {
  const expired = [];
  for (const [eventId, record] of detections) {
    if (record.expiresAt <= now) {
      expired.push({ ...record, status: "expired" });
      detections.delete(eventId);
    }
  }
  return expired;
}

export function clearStale(now = Date.now()) {
  const removed = pruneExpired(now);
  return removed.length;
}

export function stats() {
  const now = Date.now();
  let active = 0;
  for (const record of detections.values()) {
    if (record.expiresAt > now) active += 1;
  }
  return {
    active,
    stored: detections.size,
    totalSpots,
  };
}
