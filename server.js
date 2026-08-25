// ═════════════════════════════════════════════════════════════════════
// AFS WORLD BOSS AUTO-JOINER — BACKEND
// Mirrors the Saint Finder architecture (Steal a Brainrot):
//   • /api/free/validate  →  hide.lat-style key validation
//   • /ws                  →  WebSocket broadcast of world boss spawns
//   • /api/report          →  headless AFS clients push world boss sightings
//
// WORLD BOSSES — verified against the LIVE game config
// (ReplicatedStorage.Descriptions.EntityDescriptions, Dimension 2, v26).
// Every entry below has isBoss = true in-game. Display names are the
// exact strings the game renders on each boss billboard.
// NOTE: in-game, "Sand Demon" is SHUKAKU; Crocodile's billboard reads
// "Alligator". RumblingColossal was removed on purpose (not a world boss).
//
// Detection source (live game):
//   Entities spawn into Workspace.ClientEntities named after their
//   EntityType, and bosses receive the CollectionService tag "isBoss".
//
// Deploy:
//   npm install express ws cors
//   node server.js
//   (or push to Railway / Render / Fly.io / VPS)
// ═════════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';

const PORT      = process.env.PORT || 8080;
const PLACE_ID  = 122385531796312;           // AFS Dimension 2
const UNIVERSE  = 10321202755;

// ═════════════════════════════════════════════════════════════════════
// WORLD BOSS CATALOG (verified vs live EntityDescriptions, D2 v26)
// Used to validate reports + send display info to clients
// ═════════════════════════════════════════════════════════════════════
const WORLD_BOSSES = {
  Crocodile: {
    displayName: 'Alligator',
    entityType: 'Crocodile',
    category: 'world',
    drops: ['Sand (9%)', 'CrocodileMount (40%)', 'CrocodileCape (3%)', 'TraitReroll (25%)'],
    rewards: '500 Yen, 300 Chikara',
    iconColor: '#d4a574',
  },
  HandDemon: {
    displayName: 'Hand Demon',
    entityType: 'HandDemon',
    category: 'world',
    drops: ['WardingMask (6.5%)', 'DevourerTitle (4.5%)', 'TraitReroll (15%)'],
    rewards: '500 Yen, 300 Chikara, 300 TenseiShards',
    iconColor: '#8b3a3a',
  },
  SeaBeast: {
    displayName: 'Sea Beast',
    entityType: 'SeaBeast',
    category: 'world',
    drops: ['FruitRoll (5%)', 'ToothNecklace (3%)', 'SeaEmperor (0.5%)', 'TraitReroll (15%)'],
    rewards: '500 Yen, 300 Chikara, 300 TenseiShards',
    iconColor: '#2c7be0',
  },
  Shukaku: {
    // In-game billboard name for Shukaku is literally "Sand Demon".
    displayName: 'Sand Demon',
    entityType: 'Shukaku',
    category: 'world',
    drops: ['SandBerserkMode (5%)', 'SandGourd (1%)', 'TraitReroll (15%)'],
    rewards: '500 Yen, 300 Chikara, 300 TenseiShards',
    iconColor: '#e0a040',
  },
  FoundingTitan: {
    displayName: 'Founding Titan',
    entityType: 'FoundingTitan',
    category: 'world',
    drops: ['ShiftingSerum (25%)', 'ScoutCape (10%)', 'Liberator (0.5%)'],
    rewards: '4500-5000 Yen, 4000-5000 Chikara',
    iconColor: '#a07050',
  },
  ArmoredTitan: {
    displayName: 'Armored Titan',
    entityType: 'ArmoredTitan',
    category: 'world',
    drops: ['Titan-related items'],
    rewards: 'High-tier Yen + Chikara',
    iconColor: '#7080a0',
  },
};

const ALL_BOSS_TYPES = Object.keys(WORLD_BOSSES);

// ═════════════════════════════════════════════════════════════════════
// KEY DATABASE (persisted to keys.json — survives restarts)
// ═════════════════════════════════════════════════════════════════════
const KEY_DB = new Map();
const KEY_DB_FILE = process.env.KEY_DB_FILE || './keys.json';

function saveKeyDB() {
  try {
    const data = {};
    for (const [key, entry] of KEY_DB) {
      data[key] = { userIds: [...entry.userIds], createdAt: entry.createdAt, plan: entry.plan, note: entry.note };
    }
    fs.writeFileSync(KEY_DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[keys] failed to save:', e.message);
  }
}

function loadKeyDB() {
  try {
    if (fs.existsSync(KEY_DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEY_DB_FILE, 'utf8'));
      for (const [key, entry] of Object.entries(data)) {
        KEY_DB.set(key, {
          userIds: new Set(entry.userIds || []),
          createdAt: entry.createdAt || Date.now(),
          plan: entry.plan || 'free',
          note: entry.note || '',
        });
      }
    }
  } catch (e) {
    console.error('[keys] failed to load:', e.message);
  }
}

loadKeyDB();

// Seed demo key (only if not persisted already)
if (!KEY_DB.has('AFS-WORLD-DEMO-7K3X')) {
  KEY_DB.set('AFS-WORLD-DEMO-7K3X', {
    userIds: new Set(),
    createdAt: Date.now(),
    plan: 'free',
    note: 'demo world boss joiner key',
  });
  saveKeyDB();
}

// ═════════════════════════════════════════════════════════════════════
// BOSS SIGHTING REGISTRY
// Keyed by `${jobId}:${bossType}` to dedupe — same server + same boss type
// = same sighting (refresh, not new spawn).
// ═════════════════════════════════════════════════════════════════════
const SIGHTING_REGISTRY = new Map();
const SIGHTING_TTL_MS = 8 * 60 * 1000;  // 8 min — world bosses despawn

function registryKey(jobId, bossType) {
  return `${jobId}:${bossType}`;
}

// ═════════════════════════════════════════════════════════════════════
// ONLINE CLIENT REGISTRY (presence)
// Clients identify themselves after connecting to /ws; the server
// broadcasts client_online / client_offline so everyone sees who is
// actively running the script right now.
// ═════════════════════════════════════════════════════════════════════
const CONNECTED_USERS = new Map(); // userId -> { user, plan, ip, connectedAt, ws }

function pruneExpiredSightings() {
  const now = Date.now();
  const expired = [];
  for (const [key, info] of SIGHTING_REGISTRY) {
    if (now - info.reportedAt > SIGHTING_TTL_MS) {
      expired.push(info);
      SIGHTING_REGISTRY.delete(key);
    }
  }
  for (const info of expired) {
    broadcast({ type: 'boss_despawn', jobId: info.jobId, bossType: info.boss.entityType });
    console.log(`[registry] pruned: ${info.boss.entityType} @ ${info.jobId.slice(0, 12)}...`);
  }
}
setInterval(pruneExpiredSightings, 20 * 1000);

// ═════════════════════════════════════════════════════════════════════
// EXPRESS
// ═════════════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- /api/free/validate (mirrors hide.lat's endpoint exactly) ---
// Body: { id, key, user, timestamp }
// Returns: { ok, plan, universe } on success, { error } on failure
app.post('/api/free/validate', (req, res) => {
  const { id, key, user, timestamp } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[validate] id=${id} user=${user} key=${key ? key.slice(0, 12) + '...' : '(none)'} ip=${ip}`);

  if (!id || !key || !user) {
    return res.status(400).json({ error: 'Missing id, key, or user.' });
  }

  // Anti-replay: timestamp must be within 60s of server time
  if (timestamp) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 60) {
      return res.status(401).json({ error: 'Timestamp out of range. Sync your clock.' });
    }
  }

  const entry = KEY_DB.get(key);
  if (!entry) {
    return res.status(401).json({ error: 'Invalid key.' });
  }

  // Free tier: one user per key. Pro: multiple users.
  if (entry.plan === 'free') {
    if (entry.userIds.size > 0 && !entry.userIds.has(user)) {
      return res.status(403).json({ error: 'Key already bound to another user.' });
    }
  }
  entry.userIds.add(user);
  entry.lastSeen = Date.now();
  saveKeyDB();

  return res.json({ ok: true, plan: entry.plan, universe: UNIVERSE, supportedBosses: ALL_BOSS_TYPES });
});

// --- /api/key/create (admin only — create new keys) ---
app.post('/api/key/create', (req, res) => {
  const { adminSecret, plan = 'free', note = '' } = req.body || {};
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const newKey = 'AFS-WORLD-' + (plan === 'pro' ? 'PRO-' : 'FREE-')
                + crypto.randomBytes(4).toString('hex').toUpperCase()
                + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  KEY_DB.set(newKey, { userIds: new Set(), createdAt: Date.now(), plan, note });
  saveKeyDB();
  return res.json({ key: newKey, plan });
});

// --- /api/report (headless AFS client pushes a world boss sighting) ---
// Body: {
//   key, user,
//   jobId, dimension (1|2|3), placeId,
//   boss: { entityType, displayName?, position?, health?, maxHealth? },
//   server: { players, pingMs? }
// }
app.post('/api/report', (req, res) => {
  const { key, user, jobId, dimension, placeId, boss, server } = req.body || {};

  if (!key || !user || !jobId || !boss || !boss.entityType) {
    return res.status(400).json({ error: 'Missing fields. Required: key, user, jobId, boss.entityType' });
  }

  // Validate boss type
  if (!WORLD_BOSSES[boss.entityType]) {
    return res.status(400).json({ error: `Unknown boss type: ${boss.entityType}. Valid: ${ALL_BOSS_TYPES.join(', ')}` });
  }

  const entry = KEY_DB.get(key);
  if (!entry || !entry.userIds.has(user)) {
    return res.status(401).json({ error: 'Invalid key or unbound user.' });
  }

  const rk = registryKey(jobId, boss.entityType);
  const existing = SIGHTING_REGISTRY.get(rk);
  const now = Date.now();
  const catalog = WORLD_BOSSES[boss.entityType];

  const info = {
    jobId,
    dimension: dimension || 1,
    placeId: placeId || PLACE_ID,
    boss: {
      entityType: boss.entityType,
      displayName: catalog.displayName,
      category: catalog.category,
      health: boss.health ?? null,
      maxHealth: boss.maxHealth ?? null,
      position: boss.position ?? null,
    },
    drops: catalog.drops,
    rewards: catalog.rewards,
    iconColor: catalog.iconColor,
    server: {
      players: server?.players ?? 0,
      pingMs: server?.pingMs ?? 0,
    },
    reportedBy: user,
    reportedAt: now,
    firstSeen: existing?.firstSeen || now,
    updates: (existing?.updates || 0) + 1,
    isNew: !existing,
  };

  SIGHTING_REGISTRY.set(rk, info);

  // Only broadcast on FIRST sighting (avoid spamming on refresh)
  if (info.isNew) {
    broadcast({ type: 'boss_spawn', ...info });
    console.log(`[spawn] ${catalog.displayName} (${boss.entityType}) @ ${jobId.slice(0, 12)}... D${info.dimension} (${info.server.players}p)`);
  }

  return res.json({ ok: true, isNew: info.isNew, registrySize: SIGHTING_REGISTRY.size });
});

// --- /api/bosses (GET current registry — debug) ---
app.get('/api/bosses', (req, res) => {
  const list = [];
  for (const [key, info] of SIGHTING_REGISTRY) list.push({ ...info, registryKey: key });
  return res.json({ count: list.length, bosses: list });
});

// --- /api/clients (GET online script users — presence) ---
app.get('/api/clients', (req, res) => {
  const list = [];
  for (const [user, info] of CONNECTED_USERS) {
    list.push({ user, plan: info.plan, ip: info.ip, connectedAt: info.connectedAt });
  }
  return res.json({ count: list.length, clients: list });
});

// --- /api/catalog (list of supported world bosses) ---
app.get('/api/catalog', (req, res) => {
  return res.json({ bosses: WORLD_BOSSES, types: ALL_BOSS_TYPES });
});

// --- /api/health ---
app.get('/api/health', (req, res) => {
  return res.json({
    ok: true,
    uptime: process.uptime(),
    sightings: SIGHTING_REGISTRY.size,
    wsClients: wss.clients.size,
    onlineClients: CONNECTED_USERS.size,
    keys: KEY_DB.size,
  });
});

// --- Landing page + live dashboard (all data real — no test/simulation) ---
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><title>AFS World Boss Auto-Joiner</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; background:#0a0a14; color:#e0e0f0; padding:32px; max-width:900px; margin:0 auto; }
  h1 { color:#a060ff; font-size:24px; margin-bottom:4px; }
  h2 { color:#c0a0ff; font-size:16px; margin-top:24px; }
  code { background:#1a1a28; padding:2px 6px; border-radius:4px; color:#d0c0ff; font-size:12px; }
  pre { background:#1a1a28; padding:12px; border-radius:8px; overflow-x:auto; color:#d0c0ff; }
  a { color:#a060ff; }
  table { border-collapse:collapse; width:100%; margin:12px 0; }
  th, td { padding:8px 12px; text-align:left; border-bottom:1px solid #2a2a3a; }
  th { color:#a060ff; font-weight:600; }
  td code { background:transparent; color:#e0c0ff; }
  .pill { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; margin-right:4px; }
  .allig{ background:#3a2a14; color:#d4a574; }
  .hand { background:#3a1414; color:#ff8080; }
  .sea  { background:#142a4a; color:#80c0ff; }
  .shuk { background:#3a2a14; color:#e0c040; }
  .titan{ background:#2a2030; color:#c0a0c0; }
  .statgrid { display:flex; gap:16px; flex-wrap:wrap; margin:12px 0; }
  .stat { background:#14141f; border:1px solid #2a2a3a; border-radius:10px; padding:12px 18px; min-width:120px; }
  .stat .num { font-size:26px; font-weight:700; color:#c0a0ff; }
  .stat .lbl { font-size:11px; color:#8888a8; text-transform:uppercase; letter-spacing:.08em; }
  .muted { color:#666680; font-size:12px; }
</style></head><body>
<h1>AFS World Boss Auto-Joiner <span class="muted">— live dashboard</span></h1>
<p>Backend running · auto-refreshes every 5s · <a href="/api/health">/api/health</a> · <a href="/api/clients">/api/clients</a> · <a href="/api/bosses">/api/bosses</a> · <a href="/api/catalog">/api/catalog</a></p>

<div class="statgrid">
  <div class="stat"><div class="num" id="st-online">–</div><div class="lbl">Clients Online</div></div>
  <div class="stat"><div class="num" id="st-ws">–</div><div class="lbl">WS Connections</div></div>
  <div class="stat"><div class="num" id="st-bosses">–</div><div class="lbl">Active Sightings</div></div>
  <div class="stat"><div class="num" id="st-keys">–</div><div class="lbl">Keys</div></div>
  <div class="stat"><div class="num" id="st-uptime">–</div><div class="lbl">Uptime</div></div>
</div>

<h2>Clients Online</h2>
<table id="clients-table"><tr><th>User</th><th>Plan</th><th>Connected At</th></tr></table>

<h2>Active Boss Sightings <span class="muted">(reported by real clients only)</span></h2>
<table id="bosses-table"><tr><th>Boss</th><th>Dimension</th><th>Players</th><th>Health</th><th>Reported</th><th>Job ID</th></tr></table>

<h2>Supported World Bosses</h2>
<table>
<tr><th>Boss</th><th>Internal Name</th><th>Drops</th><th>Rewards</th></tr>
<tr><td><span class="pill allig">Alligator</span></td><td><code>Crocodile</code></td><td>Sand · CrocodileMount · CrocodileCape</td><td>500 Yen, 300 Chikara</td></tr>
<tr><td><span class="pill hand">Hand Demon</span></td><td><code>HandDemon</code></td><td>WardingMask · DevourerTitle</td><td>500 Yen, 300 Chikara, 300 Tensei</td></tr>
<tr><td><span class="pill sea">Sea Beast</span></td><td><code>SeaBeast</code></td><td>FruitRoll · ToothNecklace · SeaEmperor</td><td>500 Yen, 300 Chikara, 300 Tensei</td></tr>
<tr><td><span class="pill shuk">Sand Demon</span></td><td><code>Shukaku</code></td><td>SandBerserkMode · SandGourd</td><td>500 Yen, 300 Chikara, 300 Tensei</td></tr>
<tr><td><span class="pill titan">Founding Titan</span></td><td><code>FoundingTitan</code></td><td>ShiftingSerum · ScoutCape · Liberator</td><td>4500-5000 Yen, 4000-5000 Chikara</td></tr>
<tr><td><span class="pill titan">Armored Titan</span></td><td><code>ArmoredTitan</code></td><td>Titan items</td><td>High-tier</td></tr>
</table>

<h2>Endpoints</h2>
<ul>
<li><code>POST /api/free/validate</code> — key validation (hide.lat style)</li>
<li><code>POST /api/report</code> — client pushes a world boss sighting</li>
<li><code>WS  /ws</code> — subscribe to boss spawn broadcasts + presence</li>
<li><code>GET  /api/bosses</code> — current sighting registry</li>
<li><code>GET  /api/clients</code> — online script users</li>
<li><code>GET  /api/catalog</code> — supported boss list</li>
<li><code>POST /api/key/create</code> — admin only</li>
</ul>

<script>
function fmtTime(ms) {
  if (!ms) return '–';
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's';
}
async function refresh() {
  try {
    var h = await (await fetch('/api/health')).json();
    document.getElementById('st-online').textContent = h.onlineClients;
    document.getElementById('st-ws').textContent = h.wsClients;
    document.getElementById('st-bosses').textContent = h.sightings;
    document.getElementById('st-keys').textContent = h.keys;
    document.getElementById('st-uptime').textContent = fmtTime(h.uptime * 1000);
  } catch (e) {}
  try {
    var c = await (await fetch('/api/clients')).json();
    var ct = document.getElementById('clients-table');
    ct.innerHTML = '<tr><th>User</th><th>Plan</th><th>Connected At</th></tr>';
    if (!c.count) ct.innerHTML += '<tr><td colspan="3" class="muted">No clients online right now.</td></tr>';
    c.clients.forEach(function (cl) {
      ct.innerHTML += '<tr><td>' + cl.user + '</td><td>' + cl.plan + '</td><td>' + new Date(cl.connectedAt).toLocaleTimeString() + '</td></tr>';
    });
  } catch (e) {}
  try {
    var b = await (await fetch('/api/bosses')).json();
    var bt = document.getElementById('bosses-table');
    bt.innerHTML = '<tr><th>Boss</th><th>Dimension</th><th>Players</th><th>Health</th><th>Reported</th><th>Job ID</th></tr>';
    if (!b.count) bt.innerHTML += '<tr><td colspan="6" class="muted">No active sightings. Cards appear the moment a running client detects a world boss spawn.</td></tr>';
    b.bosses.forEach(function (s) {
      var hp = s.boss.maxHealth ? Math.round((s.boss.health || 0) / s.boss.maxHealth * 100) + '%' : '–';
      bt.innerHTML += '<tr><td style="color:' + (s.iconColor || '#fff') + '">' + s.boss.displayName + '</td><td>D' + s.dimension + '</td><td>'
        + s.server.players + '</td><td>' + hp + '</td><td>' + new Date(s.reportedAt).toLocaleTimeString() + '</td><td><code>'
        + s.jobId.slice(0, 14) + '…</code></td></tr>';
    });
  } catch (e) {}
}
refresh();
setInterval(refresh, 5000);
</script>
</body></html>`);
});

// ═════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER (mirrors saintfinder-port-websocket-production.up.railway.app/ws)
// Broadcasts:
//   { type:'boss_spawn',   jobId, dimension, boss:{...}, drops, rewards, ... }
//   { type:'boss_despawn', jobId, bossType }
//   { type:'hello',         message, bossCount }
// ═════════════════════════════════════════════════════════════════════
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  let n = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
      n++;
    }
  }
  const bossTag = obj.boss?.displayName || obj.bossType || '';
  console.log(`[ws] broadcast → ${n} clients: ${obj.type} ${bossTag} jobId=${(obj.jobId || '').slice(0, 12)}`);
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[ws] connect from ${ip} (total: ${wss.clients.size})`);
  ws._lastMessage = Date.now();

  // Send current registry immediately on connect
  for (const [key, info] of SIGHTING_REGISTRY) {
    ws.send(JSON.stringify({ type: 'boss_spawn', ...info }));
  }
  ws.send(JSON.stringify({
    type: 'hello',
    message: 'Connected to AFS World Boss Auto-Joiner',
    bossCount: SIGHTING_REGISTRY.size,
    onlineCount: CONNECTED_USERS.size,
    supportedBosses: ALL_BOSS_TYPES,
  }));

  ws.on('message', (data) => {
    // Any app-level message proves the client is alive — many executor
    // WebSocket implementations never answer protocol-level pings, so
    // liveness must not depend on pong frames alone.
    ws.isAlive = true;
    ws._lastMessage = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      }
      // Clients can subscribe to specific boss types
      if (msg.type === 'subscribe' && Array.isArray(msg.bossTypes)) {
        ws._subscriptions = new Set(msg.bossTypes);
        ws.send(JSON.stringify({ type: 'subscribed', bossTypes: msg.bossTypes }));
      }
      // Identify: { type:'identify', user, key } — registered after key validation
      if (msg.type === 'identify') {
        const user = String(msg.user || '');
        const key = String(msg.key || '');
        const entry = KEY_DB.get(key);
        const result = { type: 'identify_result' };
        if (!user || !entry || !entry.userIds.has(user)) {
          result.ok = false;
          result.error = 'Invalid key or unbound user. Validate first via /api/free/validate.';
          ws.send(JSON.stringify(result));
          return;
        }
        // Same user reconnecting (reconnect loop) — replace socket, no re-broadcast
        const already = CONNECTED_USERS.get(user);
        ws._user = user;
        CONNECTED_USERS.set(user, { user, plan: entry.plan, ip, connectedAt: Date.now(), ws });
        ws.send(JSON.stringify({ ...result, ok: true, user, plan: entry.plan }));
        if (!already) {
          broadcast({ type: 'client_online', user, plan: entry.plan, connectedAt: Date.now(), onlineCount: CONNECTED_USERS.size });
          console.log(`[presence] ${user} online (plan=${entry.plan}, total: ${CONNECTED_USERS.size})`);
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    if (ws._user) {
      const cur = CONNECTED_USERS.get(ws._user);
      if (cur && cur.ws === ws) {
        CONNECTED_USERS.delete(ws._user);
        broadcast({ type: 'client_offline', user: ws._user, onlineCount: CONNECTED_USERS.size });
        console.log(`[presence] ${ws._user} offline (total: ${CONNECTED_USERS.size})`);
      }
    }
    console.log(`[ws] disconnect (remaining: ${wss.clients.size})`);
  });
});

// Heartbeat — protocol pings alone can't be trusted with executor
// WebSocket clients (many never send pong frames). A client is only
// terminated when it failed the last pong check AND has sent nothing
// app-level (e.g. its 25s keepalive ping) for over 75 seconds.
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      if (now - (ws._lastMessage || now) > 75 * 1000) {
        ws.terminate();
        continue;
      }
      // Recent app-level traffic — give it another cycle instead of killing it.
      ws.isAlive = true;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30 * 1000);

// ═════════════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AFS World Boss Auto-Joiner — Backend');
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  HTTP : http://0.0.0.0:${PORT}`);
  console.log(`  WS   : ws://0.0.0.0:${PORT}/ws`);
  console.log(`  Place: ${PLACE_ID} (AFS Dimension 2)`);
  console.log(`  Demo : AFS-WORLD-DEMO-7K3X`);
  console.log(`  Bosses: ${ALL_BOSS_TYPES.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════');
});
