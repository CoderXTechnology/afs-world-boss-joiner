// Admin dashboard logic. The ADMIN_TOKEN is never stored here — the login
// POST returns an httpOnly session cookie that the browser attaches itself.
const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const dashView = $("dash-view");
let pollTimer = null;

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  return res;
}

function showLogin() {
  clearInterval(pollTimer);
  pollTimer = null;
  loginView.classList.remove("hidden");
  dashView.classList.add("hidden");
}

function showDash() {
  loginView.classList.add("hidden");
  dashView.classList.remove("hidden");
  refresh();
  if (!pollTimer) pollTimer = setInterval(refresh, 5000);
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function shortJob(jobId) {
  return jobId.length > 14 ? `${jobId.slice(0, 10)}…` : jobId;
}

async function refresh() {
  try {
    const res = await api("/admin/api/overview");
    const data = await res.json();
    render(data);
  } catch {
    $("conn-note").textContent = "connection lost — retrying…";
  }
}

function render(data) {
  $("conn-note").textContent = `uptime ${Math.floor(data.status.uptime / 60)}m · ${data.status.nodeEnv}`;
  $("card-backend").textContent = "ONLINE";
  $("card-servers").textContent = data.servers.online;
  $("card-bosses").textContent = data.detections.active;
  $("card-total").textContent = data.detections.totalSpots;
  $("card-ws").textContent = data.wsConnections;

  const body = $("spots-body");
  body.innerHTML = "";
  if (data.spots.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="muted">No active bosses.</td></tr>`;
  } else {
    const now = data.status.serverTime;
    for (const spot of data.spots) {
      const tr = document.createElement("tr");
      const age = fmtAge(now - spot.detectedAt);
      const fresh = now - spot.detectedAt < 60_000;
      tr.innerHTML = `
        <td><strong>${escapeHtml(spot.boss.name)}</strong></td>
        <td>${escapeHtml(spot.boss.rarity)}</td>
        <td>${escapeHtml(spot.boss.variant)}</td>
        <td>${spot.boss.maxHealth || "—"}</td>
        <td>${spot.players}/${spot.maxPlayers}</td>
        <td>${spot.placeId}</td>
        <td><code title="${escapeHtml(spot.jobId)}">${shortJob(spot.jobId)}</code></td>
        <td>${age}</td>
        <td><span class="badge ${fresh ? "" : "stale"}">${fresh ? "LIVE" : "AGING"}</span></td>
        <td class="actions">
          <button data-act="join" data-id="${spot.eventId}">Join</button>
          <button data-act="copy" data-id="${spot.eventId}">Copy Job</button>
          <button data-act="raw" data-id="${spot.eventId}">JSON</button>
          <button data-act="remove" data-id="${spot.eventId}" class="danger">✕</button>
        </td>`;
      body.appendChild(tr);
    }
  }

  const serversBody = $("servers-body");
  serversBody.innerHTML = "";
  if (data.serverList.length === 0) {
    serversBody.innerHTML = `<tr><td colspan="4" class="muted">No servers online.</td></tr>`;
  } else {
    for (const server of data.serverList) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${server.placeId}</td>
        <td><code title="${escapeHtml(server.jobId)}">${shortJob(server.jobId)}</code></td>
        <td>${server.players}/${server.maxPlayers}</td>
        <td>${fmtAge(data.status.serverTime - server.lastSeen)} ago</td>`;
      serversBody.appendChild(tr);
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

// Table actions
$("spots-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  const eventId = button.dataset.id;
  const act = button.dataset.act;

  if (act === "copy") {
    const res = await api(`/admin/api/raw/${encodeURIComponent(eventId)}`);
    const record = await res.json();
    await navigator.clipboard.writeText(record.jobId);
    button.textContent = "Copied!";
    setTimeout(() => (button.textContent = "Copy Job"), 1200);
  } else if (act === "raw") {
    const res = await api(`/admin/api/raw/${encodeURIComponent(eventId)}`);
    $("raw-content").textContent = await res.text();
    $("raw-modal").classList.remove("hidden");
  } else if (act === "remove") {
    await api(`/admin/api/spot/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    refresh();
  } else if (act === "join") {
    const res = await api(`/admin/api/raw/${encodeURIComponent(eventId)}`);
    const record = await res.json();
    window.open(
      `https://www.roblox.com/games/start?placeId=${record.placeId}&gameInstanceId=${encodeURIComponent(record.jobId)}`,
      "_blank"
    );
  }
});

// Header actions
$("btn-refresh").addEventListener("click", refresh);
$("btn-clear-stale").addEventListener("click", async () => {
  await api("/admin/api/clear-stale", { method: "POST" });
  refresh();
});
$("btn-logout").addEventListener("click", async () => {
  await api("/admin/api/logout", { method: "POST" });
  showLogin();
});
$("raw-close").addEventListener("click", () => $("raw-modal").classList.add("hidden"));

// Login
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    const res = await fetch("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token: $("login-token").value }),
    });
    if (!res.ok) {
      $("login-error").textContent = "Wrong token.";
      return;
    }
    $("login-token").value = "";
    showDash();
  } catch {
    $("login-error").textContent = "Network error.";
  }
});

// Boot: check existing session
(async () => {
  try {
    const res = await fetch("/admin/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (data.authenticated) showDash();
    else showLogin();
  } catch {
    showLogin();
  }
})();
