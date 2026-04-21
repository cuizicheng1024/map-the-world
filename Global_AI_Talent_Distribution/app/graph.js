import { debounce, fetchJson, getQueryParam, setQueryParam } from "./common.js";

const DATA_PATH = "../data/relations.json";
const PERSON_COLOR = "#4285F4";
const ORG_COLOR = "#C5221F";
const EDGE_COLOR = "rgba(144,164,174,0.56)";
const EDGE_HL = "rgba(26,115,232,0.95)";
const BG = "rgba(0,0,0,0)";

const canvas = document.getElementById("graphCanvas");
const searchInput = document.getElementById("searchInput");
const layoutRoot = document.getElementById("layoutRoot");
const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
const layoutRingBtn = document.getElementById("layoutRingBtn");
const layoutRadialBtn = document.getElementById("layoutRadialBtn");
const layoutGeoBtn = document.getElementById("layoutGeoBtn");
const layoutForceBtn = document.getElementById("layoutForceBtn");
const geoYearField = document.getElementById("geoYearField");
const geoYearInput = document.getElementById("geoYear");
const geoYearLabel = document.getElementById("geoYearLabel");
const toggleEdgesBtn = document.getElementById("toggleEdgesBtn");
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
let forceState = { running: false, raf: 0, iter: 0, maxIter: 320 };
let dragNodeId = "";
let dragStart = { x: 0, y: 0, px: 0, py: 0, moved: false };
let showEdges = true;

function computePageRank({ damping = 0.85, iterations = 24 } = {}) {
  const ids = nodes.map((n) => n.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  if (!n) return;

  const out = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a == null || b == null) continue;
    out[a].push(b);
    out[b].push(a);
  }

  let pr = new Array(n).fill(1 / n);
  const base = (1 - damping) / n;

  for (let it = 0; it < iterations; it++) {
    const next = new Array(n).fill(base);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const deg = out[i].length;
      if (!deg) dangling += pr[i];
    }
    const danglingShare = (damping * dangling) / n;
    for (let i = 0; i < n; i++) next[i] += danglingShare;
    for (let i = 0; i < n; i++) {
      const deg = out[i].length;
      if (!deg) continue;
      const share = (damping * pr[i]) / deg;
      for (const j of out[i]) next[j] += share;
    }
    pr = next;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of pr) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1e-12, max - min);
  for (const node of nodes) {
    const v = pr[idx.get(node.id)] ?? (1 / n);
    const norm = (v - min) / span;
    const gamma = 0.55;
    node.pr = v;
    node.prNorm = Math.pow(norm, gamma);
  }
}

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
  if (layoutMode !== "force") stopForceAtlas2();
  if (layoutMode === "radial") {
    setRadialLayout();
    return;
  }
  if (layoutMode === "geo") {
    setGeoLayout();
    return;
  }
  if (layoutMode === "force") {
    setForceLayout();
    return;
  }
  setRingLayout();
}

function startForceAtlas2() {
  if (forceState.running) return;
  forceState.running = true;
  forceState.iter = 0;
  forceState.maxIter = 320;
  forceState.raf = requestAnimationFrame(stepForceAtlas2);
}

function stopForceAtlas2() {
  if (!forceState.running) return;
  forceState.running = false;
  if (forceState.raf) cancelAnimationFrame(forceState.raf);
  forceState.raf = 0;
}

function setForceLayout() {
  const cx = width / 2;
  const cy = height / 2;
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || (n.x === 0 && n.y === 0)) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 120;
      n.x = cx + Math.cos(a) * r;
      n.y = cy + Math.sin(a) * r;
    }
    n.vx = n.vx || 0;
    n.vy = n.vy || 0;
  }
  view = { x: 0, y: 0, k: 1 };
  startForceAtlas2();
}

function stepForceAtlas2() {
  if (!forceState.running) return;
  const cx = width / 2;
  const cy = height / 2;

  const stepsPerFrame = 3;
  const scalingRatio = 18;
  const gravity = 0.08;
  const damping = 0.72;
  const maxStep = 3.2;
  const edgeWeight = 0.06;

  const deg = new Map();
  for (const n of nodes) deg.set(n.id, neighbors.get(n.id)?.size ?? 0);

  for (let s = 0; s < stepsPerFrame; s++) {
    const fx = new Map(nodes.map((n) => [n.id, 0]));
    const fy = new Map(nodes.map((n) => [n.id, 0]));

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ma = 1 + Math.log1p(deg.get(a.id) ?? 0);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const mb = 1 + Math.log1p(deg.get(b.id) ?? 0);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) {
          dx = (Math.random() - 0.5) * 0.01;
          dy = (Math.random() - 0.5) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        const f = (scalingRatio * ma * mb) / d2;
        fx.set(a.id, fx.get(a.id) + dx * f);
        fy.set(a.id, fy.get(a.id) + dy * f);
        fx.set(b.id, fx.get(b.id) - dx * f);
        fy.set(b.id, fy.get(b.id) - dy * f);
      }
    }

    for (const e of edges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = edgeWeight * dist;
      fx.set(a.id, fx.get(a.id) + dx * f);
      fy.set(a.id, fy.get(a.id) + dy * f);
      fx.set(b.id, fx.get(b.id) - dx * f);
      fy.set(b.id, fy.get(b.id) - dy * f);
    }

    for (const n of nodes) {
      const m = 1 + Math.log1p(deg.get(n.id) ?? 0);
      const gx = (cx - n.x) * gravity * m;
      const gy = (cy - n.y) * gravity * m;
      const dx = (fx.get(n.id) + gx) * 0.0022;
      const dy = (fy.get(n.id) + gy) * 0.0022;
      n.vx = (n.vx + dx) * damping;
      n.vy = (n.vy + dy) * damping;
      const step = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      const k = step > maxStep ? maxStep / step : 1;
      n.x += n.vx * k;
      n.y += n.vy * k;
    }

    forceState.iter += 1;
    if (forceState.iter >= forceState.maxIter) {
      stopForceAtlas2();
      break;
    }
  }

  forceState.raf = requestAnimationFrame(stepForceAtlas2);
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

async function fetchNodeSummary(nodeId) {
  const res = await fetch("../api/node_summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: nodeId }),
  });
  return await res.json();
}

function getNodeSummaryText(node) {
  const s = String(node.summary || node.contribution || "").trim();
  return s;
}

function sanitizeUncertainText(s) {
  return String(s || "")
    .replace(/可能/g, "需核实")
    .replace(/疑似/g, "需核实")
    .replace(/据称/g, "未经核实")
    .replace(/大概/g, "需核实")
    .trim();
}

function showPopup(node, pageX, pageY) {
  clearPopup();
  const detail = getNodeSummaryText(node);
  const verify = node.verify && typeof node.verify === "object" ? node.verify : null;
  const status = String(verify?.status || "").trim();
  const conf = typeof verify?.confidence === "number" ? verify.confidence : parseFloat(String(verify?.confidence || ""));
  const hasVerify = status === "verified" || status === "suspect" || status === "unknown";
  const statusText = status === "verified" ? "已核验" : status === "suspect" ? "需核实" : status === "unknown" ? "无法确认" : "";
  const badge = hasVerify ? `校验：${statusText}${Number.isFinite(conf) ? ` · ${(conf * 100).toFixed(0)}%` : ""}` : "";
  const note = hasVerify ? sanitizeUncertainText(String(verify?.notes || "")) : "";
  const shouldTrustSummary = status === "verified";
  const bodyText = shouldTrustSummary ? (detail || "暂无可靠公开简介") : note || "暂无可靠公开简介";

  const el = document.createElement("div");
  el.dataset.nodeId = String(node.id || "");
  el.style.position = "absolute";
  el.style.left = `${pageX + 12}px`;
  el.style.top = `${pageY + 12}px`;
  el.style.background = "rgba(255,255,255,0.94)";
  el.style.border = `1px solid ${node.kind === "person" ? PERSON_COLOR : ORG_COLOR}`;
  el.style.borderRadius = "10px";
  el.style.padding = "10px 12px";
  el.style.maxWidth = "320px";
  el.style.color = "rgba(32,33,36,0.96)";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.45";
  el.style.zIndex = "20";
  el.style.boxShadow = "0 12px 34px rgba(0,0,0,0.18)";
  const subtitle = node.kind === "person" ? "人物" : "公司/机构";
  const badgeHtml = badge ? `<div style="opacity:0.7;font-size:12px;margin-bottom:6px;">${escapeHtml(badge)}</div>` : "";
  el.innerHTML = `<div style=\"font-weight:700;margin-bottom:4px;\">${escapeHtml(node.label)}</div><div style=\"opacity:0.7;font-size:12px;margin-bottom:6px;\">${escapeHtml(subtitle)}</div>${badgeHtml}<div style=\"opacity:0.9\" id=\"popupBody\">${escapeHtml(bodyText)}</div>`;
  document.body.appendChild(el);
  popupEl = el;

  if (hasVerify && !shouldTrustSummary) return;
  if (detail) return;
  fetchNodeSummary(node.id)
    .then((data) => {
      if (!popupEl || popupEl.dataset.nodeId !== String(node.id || "")) return;
      if (!data || !data.ok) return;
      if (data.summary) node.summary = String(data.summary);
      if (Array.isArray(data.aliases)) node.aliases = data.aliases;
      const body = popupEl.querySelector("#popupBody");
      if (body) body.textContent = String(node.summary || "暂无可靠公开简介");
    })
    .catch(() => {});
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

  if (showEdges) {
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
  }

  for (const n of nodes) {
    const isSelected = n.id === selectedId;
    const isHL = hl ? hl.has(n.id) : true;
    const isHover = n.id === hoveredId;
    const alpha = hl ? (isHL ? 1 : 0.18) : 1;
    const baseAlpha = selectedId ? alpha : n.kind === "person" ? 0.86 : 0.52;
    ctx.globalAlpha = isSelected || isHover ? 1 : baseAlpha;
    const pr = Math.max(0, Math.min(1, n.prNorm ?? 0.4));
    const baseR = n.kind === "person" ? 4.4 : 4.0;
    const prAdd = 1.2 + pr * 5.2;
    const kindScale = n.kind === "person" ? 1 : 0.86;
    const r = (isSelected ? 8.8 : isHover ? 8.2 : (baseR + prAdd) * kindScale) / view.k;
    ctx.beginPath();
    ctx.fillStyle = n.kind === "person" ? PERSON_COLOR : ORG_COLOR;
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.stroke();

    if (view.k > 0.9 && (isSelected || isHover || (hl && isHL))) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = n.kind === "person" ? "rgba(66,133,244,0.95)" : "rgba(219,68,55,0.9)";
      ctx.font = `${11 / view.k}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      const prefix = n.kind === "person" ? "P · " : "O · ";
      ctx.fillText(prefix + n.label, n.x + 9 / view.k, n.y + 4 / view.k);
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
  if (dragStart.moved) return;
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
  return;
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
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const n = pickNodeAt(x, y);
  dragStart = { x: ev.clientX, y: ev.clientY, px: x, py: y, moved: false };
  if (n) {
    dragNodeId = n.id;
    canvas.style.cursor = "grabbing";
    return;
  }
  dragNodeId = "";
  isPanning = true;
  panStart = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  canvas.style.cursor = "grabbing";
}

function onMouseUp() {
  isPanning = false;
  dragNodeId = "";
  setTimeout(() => {
    dragStart.moved = false;
  }, 0);
}

function onMouseDrag(ev) {
  const dxPage = ev.clientX - dragStart.x;
  const dyPage = ev.clientY - dragStart.y;
  if (!dragStart.moved && (Math.abs(dxPage) > 3 || Math.abs(dyPage) > 3)) dragStart.moved = true;

  if (dragNodeId) {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const w = screenToWorld(x, y);
    const n = nodeById.get(dragNodeId);
    if (n) {
      n.x = w.x;
      n.y = w.y;
      n.vx = 0;
      n.vy = 0;
    }
    return;
  }

  if (!isPanning) return;
  view.x = panStart.vx + dxPage;
  view.y = panStart.vy + dyPage;
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
  computePageRank();
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
  layoutForceBtn?.classList.toggle("secondary", nextMode !== "force");
  setGeoYearVisible(nextMode === "geo");
  setLayout();
}

function setShowEdges(next) {
  showEdges = Boolean(next);
  if (toggleEdgesBtn) {
    toggleEdgesBtn.textContent = showEdges ? "关联线：开" : "关联线：关";
    toggleEdgesBtn.classList.toggle("secondary", !showEdges);
  }
}

layoutRingBtn?.addEventListener("click", () => setLayoutMode("ring"));
layoutRadialBtn?.addEventListener("click", () => setLayoutMode("radial"));
layoutGeoBtn?.addEventListener("click", () => setLayoutMode("geo"));
layoutForceBtn?.addEventListener("click", () => setLayoutMode("force"));
toggleEdgesBtn?.addEventListener("click", () => setShowEdges(!showEdges));

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
