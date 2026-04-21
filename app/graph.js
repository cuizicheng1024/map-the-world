import { debounce, fetchJson, getQueryParam, setQueryParam } from "./common.js";

const DATA_PATH = "../data/relations.json";
const PERSON_COLOR = "#00E5FF";
const ORG_COLOR = "#FF3B91";
const EDGE_COLOR = "rgba(230,230,234,0.16)";
const EDGE_HL = "rgba(0,229,255,0.85)";
const LABEL_COLOR = "rgba(230,230,234,0.85)";
const BG = "rgba(0,0,0,0)";

const canvas = document.getElementById("graphCanvas");
const searchInput = document.getElementById("searchInput");
const layoutRoot = document.getElementById("layoutRoot");
const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
const layoutRingBtn = document.getElementById("layoutRingBtn");
const layoutRadialBtn = document.getElementById("layoutRadialBtn");
const layoutGeoBtn = document.getElementById("layoutGeoBtn");
const geoYearField = document.getElementById("geoYearField");
const geoYearInput = document.getElementById("geoYear");
const geoYearLabel = document.getElementById("geoYearLabel");
const ctx = canvas.getContext("2d");

let width = 0;
let height = 0;
let nodes = [];
let edges = [];
let nodeById = new Map();
let neighbors = new Map();
let selectedId = "";
let hoveredId = "";
let view = { x: 0, y: 0, k: 1 };
let isPanning = false;
let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
let popupEl = null;
let layoutMode = "ring";
let geoYear = 2026;
let movementByPersonYear = null;

function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  width = Math.max(1, Math.floor(rect.width));
  height = Math.max(1, Math.floor(rect.height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function buildIndex() {
  nodeById = new Map(nodes.map((n) => [n.id, n]));
  neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
    if (!neighbors.has(e.to)) neighbors.set(e.to, new Set());
    neighbors.get(e.from).add(e.to);
    neighbors.get(e.to).add(e.from);
  }
}

function setLayout() {
  if (layoutMode === "radial") {
    setRadialLayout();
    return;
  }
  if (layoutMode === "geo") {
    setGeoLayout();
    return;
  }
  setRingLayout();
}

function setRingLayout() {
  const cx = width / 2;
  const cy = height / 2;
  const rOuter = Math.max(140, Math.min(width, height) * 0.39);
  const rInner = Math.max(90, Math.min(width, height) * 0.22);

  const persons = nodes.filter((n) => n.kind === "person");
  const orgs = nodes.filter((n) => n.kind !== "person");

  persons.forEach((n, i) => {
    const t = (i / Math.max(1, persons.length)) * Math.PI * 2;
    n.x = cx + Math.cos(t) * rOuter;
    n.y = cy + Math.sin(t) * rOuter;
    n.vx = 0;
    n.vy = 0;
  });

  orgs.forEach((n, i) => {
    const t = (i / Math.max(1, orgs.length)) * Math.PI * 2;
    n.x = cx + Math.cos(t) * rInner;
    n.y = cy + Math.sin(t) * rInner;
    n.vx = 0;
    n.vy = 0;
  });

  view = { x: 0, y: 0, k: 1 };
}

function setRadialLayout() {
  const cx = width / 2;
  const cy = height / 2;
  const pad = 36;
  const maxR = Math.max(140, Math.min(width, height) / 2 - pad);

  let root = selectedId ? nodeById.get(selectedId) : null;
  if (!root) {
    let best = null;
    let bestDeg = -1;
    for (const n of nodes) {
      if (n.kind !== "person") continue;
      const d = neighbors.get(n.id)?.size ?? 0;
      if (d > bestDeg) {
        bestDeg = d;
        best = n;
      }
    }
    root = best ?? nodes[0];
  }
  if (!root) return;

  const depth = new Map();
  const order = [];
  const q = [root.id];
  depth.set(root.id, 0);

  while (q.length) {
    const id = q.shift();
    order.push(id);
    const nb = neighbors.get(id);
    if (!nb) continue;
    for (const other of nb) {
      if (depth.has(other)) continue;
      depth.set(other, (depth.get(id) ?? 0) + 1);
      q.push(other);
    }
  }

  const maxDepth = Math.max(...depth.values());
  const rings = Array.from({ length: maxDepth + 1 }, () => []);
  for (const id of order) rings[depth.get(id) ?? 0].push(id);

  for (let d = 0; d <= maxDepth; d++) {
    const ids = rings[d];
    const r = d === 0 ? 0 : (d / Math.max(1, maxDepth)) * maxR;
    for (let i = 0; i < ids.length; i++) {
      const t = ids.length <= 1 ? 0 : i / ids.length;
      const ang = t * Math.PI * 2;
      const n = nodeById.get(ids[i]);
      if (!n) continue;
      n.x = cx + Math.cos(ang) * r;
      n.y = cy + Math.sin(ang) * r;
      n.vx = 0;
      n.vy = 0;
    }
  }

  const placed = new Set(depth.keys());
  const rest = nodes.filter((n) => !placed.has(n.id));
  const rRest = Math.max(maxR * 0.82, 180);
  rest.forEach((n, i) => {
    const ang = (i / Math.max(1, rest.length)) * Math.PI * 2;
    n.x = cx + Math.cos(ang) * rRest;
    n.y = cy + Math.sin(ang) * rRest;
    n.vx = 0;
    n.vy = 0;
  });

  root.x = cx;
  root.y = cy;

  view = { x: 0, y: 0, k: 1 };
}

function ensureMovements() {
  if (movementByPersonYear) return Promise.resolve(movementByPersonYear);
  return fetch("../data/movements.geojson", { cache: "no-store" })
    .then((r) => r.json())
    .then((gj) => {
      const map = new Map();
      for (const ft of gj.features ?? []) {
        if (!ft?.geometry || ft.geometry.type !== "Point") continue;
        const c = ft.geometry.coordinates;
        if (!Array.isArray(c) || c.length !== 2) continue;
        const lon = c[0];
        const lat = c[1];
        if (typeof lon !== "number" || typeof lat !== "number") continue;
        const p = ft.properties ?? {};
        const pid = String(p.person_id ?? "");
        const y = typeof p.year === "number" ? p.year : parseInt(String(p.year ?? ""), 10);
        if (!pid || !Number.isFinite(y)) continue;
        if (!map.has(pid)) map.set(pid, new Map());
        map.get(pid).set(y, { lon, lat });
      }
      movementByPersonYear = map;
      return map;
    });
}

function setGeoLayout() {
  ensureMovements().then(() => {
    if (layoutMode !== "geo") return;
    const pad = 28;
    const w = Math.max(1, width - pad * 2);
    const h = Math.max(1, height - pad * 2);
    const loc = movementByPersonYear;

    const persons = nodes.filter((n) => n.kind === "person");
    const orgs = nodes.filter((n) => n.kind !== "person");

    persons.forEach((n) => {
      const rec = loc.get(n.id)?.get(geoYear);
      if (rec) {
        n.x = pad + ((rec.lon + 180) / 360) * w;
        n.y = pad + ((90 - rec.lat) / 180) * h;
      } else {
        n.x = pad + Math.random() * w;
        n.y = height - pad - Math.random() * 60;
      }
      n.vx = 0;
      n.vy = 0;
    });

    orgs.forEach((n) => {
      const nb = neighbors.get(n.id);
      const ps = nb ? [...nb].map((id) => nodeById.get(id)).filter((x) => x?.kind === "person") : [];
      if (!ps.length) {
        n.x = width - pad - Math.random() * 120;
        n.y = pad + Math.random() * h;
      } else {
        let sx = 0;
        let sy = 0;
        for (const p of ps) {
          sx += p.x;
          sy += p.y;
        }
        n.x = sx / ps.length + 38;
        n.y = sy / ps.length;
      }
      n.vx = 0;
      n.vy = 0;
    });

    view = { x: 0, y: 0, k: 1 };
  });
}

function worldToScreen(p) {
  return { x: p.x * view.k + view.x, y: p.y * view.k + view.y };
}

function screenToWorld(x, y) {
  return { x: (x - view.x) / view.k, y: (y - view.y) / view.k };
}

function pickNodeAt(x, y) {
  const w = screenToWorld(x, y);
  let best = null;
  let bestD2 = Infinity;
  for (const n of nodes) {
    const dx = n.x - w.x;
    const dy = n.y - w.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = n;
    }
  }
  const hitR = 10 / view.k;
  if (!best) return null;
  return bestD2 <= hitR * hitR ? best : null;
}

function highlightSet() {
  const activeId = selectedId || hoveredId;
  if (!activeId) return null;
  const s = new Set([activeId]);
  const nb = neighbors.get(activeId);
  if (nb) for (const id of nb) s.add(id);
  return s;
}

function clearPopup() {
  if (!popupEl) return;
  popupEl.remove();
  popupEl = null;
}

function showPopup(node, pageX, pageY) {
  clearPopup();
  if (node.kind !== "person") return;
  const detail = node.contribution || "暂无简介";
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = `${pageX + 12}px`;
  el.style.top = `${pageY + 12}px`;
  el.style.background = "rgba(26,26,29,0.95)";
  el.style.border = `1px solid ${PERSON_COLOR}`;
  el.style.borderRadius = "10px";
  el.style.padding = "10px 12px";
  el.style.maxWidth = "320px";
  el.style.color = "#E6E6EA";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.45";
  el.style.zIndex = "20";
  el.innerHTML = `<div style=\"font-weight:700;margin-bottom:6px;\">${escapeHtml(node.label)}</div><div style=\"opacity:0.82\">${escapeHtml(detail)}</div>`;
  document.body.appendChild(el);
  popupEl = el;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function draw() {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  const hl = highlightSet();
  const activeId = selectedId || hoveredId;

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  for (const e of edges) {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;

    if (activeId) {
      const inHL = hl ? (hl.has(e.from) || hl.has(e.to)) : true;
      const isHL = e.from === activeId || e.to === activeId;
      ctx.globalAlpha = inHL ? 1 : 0.18;
      ctx.strokeStyle = isHL ? EDGE_HL : EDGE_COLOR;
      ctx.lineWidth = isHL ? 1.8 / view.k : 1.0 / view.k;
    } else {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = EDGE_COLOR;
      ctx.lineWidth = 1.0 / view.k;
    }

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const n of nodes) {
    const isSelected = n.id === selectedId;
    const isHL = hl ? hl.has(n.id) : true;
    const isHover = n.id === hoveredId;
    const alpha = hl ? (isHL ? 1 : 0.18) : 1;
    const baseAlpha = selectedId ? alpha : n.kind === "person" ? 1 : 0.55;
    ctx.globalAlpha = baseAlpha;
    const r = (isSelected ? 7.5 : isHover ? 7 : n.kind === "person" ? 5.3 : 4.6) / view.k;
    ctx.beginPath();
    ctx.fillStyle = n.kind === "person" ? PERSON_COLOR : ORG_COLOR;
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.stroke();

    if (view.k > 0.9 && (isSelected || isHover || (hl && isHL))) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = `${11 / view.k}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      ctx.fillText(n.label, n.x + 9 / view.k, n.y + 4 / view.k);
    }
  }

  ctx.restore();
  ctx.globalAlpha = 1;

  requestAnimationFrame(draw);
}

function focusOnNode(node) {
  const s = worldToScreen(node);
  const dx = width / 2 - s.x;
  const dy = height / 2 - s.y;
  view.x += dx;
  view.y += dy;
}

function applyFocusFromQuery() {
  const focus = getQueryParam("focus");
  if (!focus) return;
  const [, id] = focus.split(":");
  if (!id) return;
  const node = nodeById.get(id) || nodes.find((n) => n.label === id);
  if (!node) return;
  selectedId = node.id;
  focusOnNode(node);
}

function setFocusQuery(nodeId) {
  if (!nodeId) {
    setQueryParam("focus", "");
    return;
  }
  setQueryParam("focus", `person:${nodeId}`);
}

function onClick(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const n = pickNodeAt(x, y);
  if (!n) {
    selectedId = "";
    clearPopup();
    setFocusQuery("");
    return;
  }
  selectedId = n.id;
  setFocusQuery(n.id);
  showPopup(n, ev.pageX, ev.pageY);
  if (layoutMode === "radial") setRadialLayout();
}

function onDoubleClick(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const n = pickNodeAt(x, y);
  if (!n) return;
  if (n.kind !== "person") return;
  const url = new URL("./cesium.html", window.location.href);
  url.searchParams.set("focus", `person:${n.id}`);
  window.open(url.toString(), "_blank");
}

function onMouseMove(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const n = pickNodeAt(x, y);
  hoveredId = n ? n.id : "";
  canvas.style.cursor = n ? "pointer" : isPanning ? "grabbing" : "default";
}

function onWheel(ev) {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const before = screenToWorld(sx, sy);
  const dz = Math.exp(-ev.deltaY * 0.0012);
  const nextK = Math.max(0.35, Math.min(2.8, view.k * dz));
  view.k = nextK;
  const after = screenToWorld(sx, sy);
  view.x += (after.x - before.x) * view.k;
  view.y += (after.y - before.y) * view.k;
}

function onMouseDown(ev) {
  isPanning = true;
  panStart = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  canvas.style.cursor = "grabbing";
}

function onMouseUp() {
  isPanning = false;
}

function onMouseDrag(ev) {
  if (!isPanning) return;
  const dx = ev.clientX - panStart.x;
  const dy = ev.clientY - panStart.y;
  view.x = panStart.vx + dx;
  view.y = panStart.vy + dy;
}

async function main() {
  resize();
  if (geoYearInput) {
    geoYear = parseInt(geoYearInput.value, 10);
    if (geoYearLabel) geoYearLabel.textContent = String(geoYear);
  }
  setGeoYearVisible(layoutMode === "geo");
  window.addEventListener("resize", debounce(() => {
    resize();
    setLayout();
  }, 120));

  const data = await fetchJson(DATA_PATH);
  nodes = (data.nodes ?? []).map((n) => ({ ...n, x: 0, y: 0 }));
  edges = (data.edges ?? []).map((e) => ({ ...e }));
  buildIndex();
  setLayout();
  applyFocusFromQuery();

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("mousemove", (ev) => {
    onMouseMove(ev);
    onMouseDrag(ev);
  });
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  searchInput.addEventListener(
    "input",
    debounce(() => {
      const kw = searchInput.value.trim().toLowerCase();
      if (!kw) return;
      const hit = nodes.find((n) => String(n.label ?? "").toLowerCase().includes(kw));
      if (!hit) return;
      selectedId = hit.id;
      setFocusQuery(hit.id);
      focusOnNode(hit);
      clearPopup();
      if (layoutMode === "radial") setRadialLayout();
    }, 160),
  );

  requestAnimationFrame(draw);
}

function setGeoYearVisible(isVisible) {
  if (geoYearField) geoYearField.hidden = !isVisible;
}

function setSidebarCollapsed(collapsed) {
  layoutRoot?.classList.toggle("collapsed", collapsed);
  if (toggleSidebarBtn) {
    toggleSidebarBtn.textContent = collapsed ? "⟩" : "⟨";
    toggleSidebarBtn.title = collapsed ? "展开侧栏" : "收起侧栏";
    toggleSidebarBtn.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
  }
  resize();
  setLayout();
}

function setLayoutMode(nextMode) {
  layoutMode = nextMode;
  layoutRingBtn?.classList.toggle("secondary", nextMode !== "ring");
  layoutRadialBtn?.classList.toggle("secondary", nextMode !== "radial");
  layoutGeoBtn?.classList.toggle("secondary", nextMode !== "geo");
  setGeoYearVisible(nextMode === "geo");
  setLayout();
}

layoutRingBtn?.addEventListener("click", () => setLayoutMode("ring"));
layoutRadialBtn?.addEventListener("click", () => setLayoutMode("radial"));
layoutGeoBtn?.addEventListener("click", () => setLayoutMode("geo"));

geoYearInput?.addEventListener("input", (ev) => {
  geoYear = parseInt(ev.target.value, 10);
  if (geoYearLabel) geoYearLabel.textContent = String(geoYear);
  if (layoutMode === "geo") setGeoLayout();
});

toggleSidebarBtn?.addEventListener("click", () => {
  const collapsed = !!layoutRoot?.classList.contains("collapsed");
  setSidebarCollapsed(!collapsed);
});

main();
