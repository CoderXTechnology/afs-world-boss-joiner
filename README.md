# AFS World Boss backend

Node.js service that collects world-boss detections from Roblox executor producers and
fans them out to finder clients (WebSocket + REST). In-memory store, no database.

## Run locally

```bash
npm install
INGEST_TOKEN=dev-ingest-token ADMIN_TOKEN=dev-admin-token npm run dev
# inject a fake detection:
SIM_BOSS=Pain npm run simulate
```

Dev fallbacks only exist when `NODE_ENV != production`; in production missing tokens crash
the process on purpose (Railway keeps restarting until the variables are set).

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `INGEST_TOKEN` | **yes (prod)** | — | Bearer token for `POST /api/spot`, `/api/despawn`, `/api/heartbeat` |
| `ADMIN_TOKEN` | **yes (prod)** | — | Login token for the `/admin` dashboard and `x-admin-token` header |
| `PORT` | no | `8080` | Listen port (Railway sets this itself) |
| `SPOT_TTL_SECONDS` | no | `90` | How long a detection stays live without a refresh |
| `SERVER_TTL_SECONDS` | no | `120` | Heartbeat silence before a game server is marked offline |
| `MAX_SPOTS` | no | `1000` | Store cap; eviction removes soonest-to-expire spots first |
| `KEY_DB_FILE` | no | `./keys.json` | User-key persistence file |
| `NODE_ENV` | no | — | Set to `production` on Railway |

## Deploying to Railway

1. This folder is self-contained (`package.json` + `src/` + `public/`). Either push its
   *contents* to the repo root, or create the service from the repo and set
   **Settings → Root Directory** to `afs-world-boss-joiner/backend`.
2. Variables: set `INGEST_TOKEN` and `ADMIN_TOKEN` (long random strings,
   e.g. `openssl rand -hex 24`). Optionally `NODE_ENV=production`.
3. Build/deploy is auto-detected (Nixpacks; see `railway.json` — healthcheck `GET /health`).
4. **Volumes:** keys persist in `keys.json` next to the app. Railway's filesystem resets on
   every deploy/restart, so attach a Volume mounted at `/app` if you want issued keys to
   survive. Without a volume the key list resets to the seeded demo key.
5. Verify: open `https://<your-domain>/health` → `{"ok":true,...}`, then log into `/admin`.

## API

All responses are JSON. Auth layers:

- **Producers** — `Authorization: Bearer <INGEST_TOKEN>`
- **Clients** — `x-access-key: <key>` header or `?key=<key>` query
- **Admin** — `x-admin-token: <ADMIN_TOKEN>` header, or session cookie from `POST /admin/api/login`

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness + counters (Railway healthcheck) |
| `POST /api/spot` | producer | report a boss spawn. Body `{eventId, placeId, jobId, boss:{id,name,rarity?,variant?,level?,maxHealth?,entityId?}, players, maxPlayers, detectedAt}` → `201 {ok:true}` or `200 {ok:true,duplicate:true}` |
| `POST /api/despawn` | producer | `{eventId, reason?}` — idempotent removal |
| `POST /api/heartbeat` | producer | `{placeId, jobId, players, maxPlayers}` — marks the server online |
| `GET /api/spots?boss=&maxAge=&limit=` | client | live detections `{spots:[...], count}` |
| `GET /api/stats` | client | `{detections:{active,stored}, servers:{online,total}, wsConnections}` |
| `WS /ws?key=<key>` (`?admin=<token>` for admin) | client/admin | live events (below) |
| `POST /admin/api/login` | — | body `{token}` → sets httpOnly `afs_admin` cookie (12 h) |
| `POST /admin/api/logout`, `GET /admin/api/session` | — | session management |
| `GET /admin/api/overview` | admin | full dashboard payload (spots, servers, counters) |
| `DELETE /admin/api/spot/:eventId` | admin | force-remove a spot |
| `POST /admin/api/clear-stale` | admin | drop expired/stale entries now |
| `GET /admin/api/raw/:eventId` | admin | exact stored record |

Validation on `POST /api/spot`: `eventId` 8–128 chars, known `placeId`/`jobId` lengths,
`detectedAt` within `[now − 2×TTL, now + 30s]`. Duplicates (same `eventId`) return
`{duplicate:true}` without re-broadcasting.

## WebSocket events

Client receives `{type, data}` frames:

- `hello` — sent right after connect `{heartbeatMs}`
- `boss_spotted` — new detection `{eventId, placeId, jobId, boss{…}, players, maxPlayers, detectedAt}`
- `boss_despawned` — `{eventId, reason}` where reason is `despawned | expired | server_offline`
- `server_online` / `server_updated` / `server_offline` — heartbeat lifecycle

Server pings every 15 s; clients that miss two pongs are dropped. The Roblox script falls
back to polling `GET /api/spots?maxAge=90&limit=100` whenever the socket is down, so a WS
outage degrades latency (~12 s) instead of breaking the feed.

## User keys

Stored in `keys.json`:

```json
{
  "AFS-WORLD-DEMO-7K3X": {
    "userIds": [],
    "createdAt": 1756000000000,
    "plan": "free",
    "note": "demo world boss joiner key"
  }
}
```

Add a key by editing the file (any string ≥ 8 chars) and restarting, or attach a volume and
manage it over SFTP/exec. There is deliberately no HTTP endpoint that creates keys.

## Internal layout

```
src/
  config.js            env parsing (throws in prod when tokens missing)
  logger.js            tagged JSON-ish console logger
  auth.js              timing-safe checks, admin sessions, key DB
  detections.js        spot store: add/remove/list/prune/stats, MAX_SPOTS eviction
  serverRegistry.js    heartbeat → online/offline tracking
  websocket.js         /ws upgrade auth, ping/pong, broadcast()
  cleanup.js           5 s sweeper: expire spots, mark dead servers, broadcast removals
  routes/              health, spot, despawn, heartbeat, spots, stats, admin
  server.js            express wiring, rate limits, graceful shutdown
scripts/simulateBoss.js fake producer (SIM_BOSS, SIM_JOB_ID, SIM_PLACE_ID, SIM_RARITY)
public/                admin dashboard (login gate → overview, spots table, servers)
```

Spot lifecycle: `POST /api/spot` → stored + broadcast `boss_spotted` → either
`POST /api/despawn`, TTL expiry, or its server going silent → removed + broadcast
`boss_despawned`. Deterministic `eventId = <jobId>:<EntityType>:<entityId>` makes every
report idempotent across producers.
