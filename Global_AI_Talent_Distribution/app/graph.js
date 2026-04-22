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
const graphOverlay = document.getElementById("graphOverlay");
const graphOverlayTitle = document.getElementById("graphOverlayTitle");
const graphOverlaySub = document.getElementById("graphOverlaySub");
const hoverTip = document.getElementById("hoverTip");
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
let layoutMode = "force";
let geoYear = 2026;
let movementByPersonYear = null;
let forceState = { running: false, raf: 0, iter: 0, maxIter: 320 };
let dragNodeId = "";
let dragStart = { x: 0, y: 0, px: 0, py: 0, moved: false };
let showEdges = false;
let settleFrames = 0;
let drawRaf = 0;
let lastHoverId = "";
let overlayHideTimer = 0;
let pointerRaf = 0;
let pointerState = { x: 0, y: 0, clientX: 0, clientY: 0, dirty: false };
let sim = null;

function scheduleDraw() {
  if (drawRaf) return;
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0;
    draw();
  });
}

function setOverlayVisible(isVisible, title, sub) {
  if (!graphOverlay) return;
  if (overlayHideTimer) window.clearTimeout(overlayHideTimer);
  overlayHideTimer = 0;
  if (isVisible) {
    graphOverlay.classList.remove("overlayFadeOut");
    graphOverlay.hidden = false;
  } else {
    graphOverlay.classList.add("overlayFadeOut");
    overlayHideTimer = window.setTimeout(() => {
      graphOverlay.hidden = true;
      graphOverlay.classList.remove("overlayFadeOut");
      overlayHideTimer = 0;
    }, 170);
  }
  if (graphOverlayTitle && title != null) graphOverlayTitle.textContent = String(title);
  if (graphOverlaySub && sub != null) graphOverlaySub.textContent = String(sub);
}

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
  const idToIndex = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n._i = i;
    idToIndex.set(n.id, i);
  }
  const deg = new Float32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    deg[i] = neighbors.get(nodes[i].id)?.size ?? 0;
  }
  const edgeFrom = new Int32Array(edges.length);
  const edgeTo = new Int32Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    edgeFrom[i] = idToIndex.get(edges[i].from) ?? -1;
    edgeTo[i] = idToIndex.get(edges[i].to) ?? -1;
  }
  sim = { idToIndex, deg, edgeFrom, edgeTo, fx: new Float32Array(nodes.length), fy: new Float32Array(nodes.length) };
}

function setLayout() {
  if (layoutMode !== "force") stopForceAtlas2();
  if (layoutMode === "radial") {
    setRadialLayout();
    scheduleDraw();
    return;
  }
  if (layoutMode === "geo") {
    setGeoLayout();
    scheduleDraw();
    return;
  }
  if (layoutMode === "force") {
    setForceLayout();
    scheduleDraw();
    return;
  }
  setRingLayout();
  scheduleDraw();
}

function startForceAtlas2() {
  if (forceState.running) return;
  forceState.running = true;
  forceState.iter = 0;
  const n = nodes.length;
  forceState.maxIter = Math.max(140, Math.min(320, 160 + Math.floor(Math.log1p(n) * 44)));
  settleFrames = 0;
  setOverlayVisible(true, "布局计算中…", "正在计算力导向布局");
  forceState.raf = requestAnimationFrame(stepForceAtlas2);
  scheduleDraw();
}

function stopForceAtlas2() {
  if (!forceState.running) return;
  forceState.running = false;
  if (forceState.raf) cancelAnimationFrame(forceState.raf);
  forceState.raf = 0;
  setOverlayVisible(false);
  scheduleDraw();
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
  if (!sim || sim.fx.length !== nodes.length) buildIndex();
  const cx = width / 2;
  const cy = height / 2;

  const stepsPerFrame = 2;
  const scalingRatio = 18;
  const gravity = 0.085;
  const damping = 0.72;
  const maxStep = 3.2;
  const edgeWeight = 0.06;
  const cellSize = 84;
  const deg = sim.deg;

  for (let s = 0; s < stepsPerFrame; s++) {
    const fx = sim.fx;
    const fy = sim.fy;
    fx.fill(0);
    fy.fill(0);

    const grid = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const gx = Math.floor(n.x / cellSize);
      const gy = Math.floor(n.y / cellSize);
      const k = `${gx},${gy}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ma = 1 + Math.log1p(deg[i] ?? 0);
      const ax = Math.floor(a.x / cellSize);
      const ay = Math.floor(a.y / cellSize);
      for (let dxCell = -1; dxCell <= 1; dxCell++) {
        for (let dyCell = -1; dyCell <= 1; dyCell++) {
          const k = `${ax + dxCell},${ay + dyCell}`;
          const bucket = grid.get(k);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = nodes[j];
            const mb = 1 + Math.log1p(deg[j] ?? 0);
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1e-4) {
              dx = (Math.random() - 0.5) * 0.01;
              dy = (Math.random() - 0.5) * 0.01;
              d2 = dx * dx + dy * dy;
            }
            const f = (scalingRatio * ma * mb) / d2;
            fx[i] += dx * f;
            fy[i] += dy * f;
            fx[j] -= dx * f;
            fy[j] -= dy * f;
          }
        }
      }
    }

    for (let ei = 0; ei < edges.length; ei++) {
      const ia = sim.edgeFrom[ei];
      const ib = sim.edgeTo[ei];
      if (ia < 0 || ib < 0) continue;
      const a = nodes[ia];
      const b = nodes[ib];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = edgeWeight * dist;
      fx[ia] += dx * f;
      fy[ia] += dy * f;
      fx[ib] -= dx * f;
      fy[ib] -= dy * f;
    }

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const m = 1 + Math.log1p(deg[i] ?? 0);
      const gx = (cx - n.x) * gravity * m;
      const gy = (cy - n.y) * gravity * m;
      const dx = (fx[i] + gx) * 0.0022;
      const dy = (fy[i] + gy) * 0.0022;
      n.vx = (n.vx + dx) * damping;
      n.vy = (n.vy + dy) * damping;
      const step = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      const k = step > maxStep ? maxStep / step : 1;
      n.x += n.vx * k;
      n.y += n.vy * k;
    }

    forceState.iter += 1;
    if (forceState.iter % 10 === 0) {
      const pct = Math.min(99, Math.floor((forceState.iter / Math.max(1, forceState.maxIter)) * 100));
      setOverlayVisible(true, "布局计算中…", `迭代 ${forceState.iter}/${forceState.maxIter} · ${pct}%`);
    }
    const avgSpeed = nodes.length
      ? nodes.reduce((acc, n) => acc + Math.sqrt((n.vx || 0) * (n.vx || 0) + (n.vy || 0) * (n.vy || 0)), 0) / nodes.length
      : 0;
    if (forceState.iter > 40 && avgSpeed < 0.06) settleFrames += 1;
    else settleFrames = 0;
    if (settleFrames >= 18) {
      stopForceAtlas2();
      return;
    }
    if (forceState.iter >= forceState.maxIter) {
      stopForceAtlas2();
      return;
    }
  }

  if (!forceState.running) return;
  forceState.raf = requestAnimationFrame(stepForceAtlas2);
  scheduleDraw();
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
    scheduleDraw();
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

function placeTip(el, x, y) {
  const pad = 12;
  const vw = Math.max(1, window.innerWidth || 1);
  const vh = Math.max(1, window.innerHeight || 1);
  const r = el.getBoundingClientRect();
  let px = x;
  let py = y;
  if (px + r.width + pad > vw) px = vw - r.width - pad;
  if (py + r.height + pad > vh) py = vh - r.height - pad;
  px = Math.max(pad, px);
  py = Math.max(pad, py);
  el.style.transform = `translate(${Math.round(px)}px,${Math.round(py)}px)`;
}

function showPopup(node, clientX, clientY) {
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
  el.className = "tipCard";
  el.style.maxWidth = "360px";
  el.style.borderColor = node.kind === "person" ? PERSON_COLOR : ORG_COLOR;
  el.style.pointerEvents = "none";
  const subtitle = node.kind === "person" ? "人物" : "公司/机构";
  const badgeHtml = badge ? `<div class="tipSub">${escapeHtml(badge)}</div>` : "";
  el.innerHTML = `<div class="tipTitle">${escapeHtml(node.label)}</div><div class="tipSub">${escapeHtml(subtitle)}</div>${badgeHtml}<div style="opacity:0.92" id="popupBody">${escapeHtml(bodyText)}</div>`;
  document.body.appendChild(el);
  placeTip(el, clientX + 12, clientY + 12);
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

function roundRectPath(c, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function setHoverTip(node) {
  if (!hoverTip) return;
  if (!node || isPanning || dragNodeId) {
    hoverTip.hidden = true;
    return;
  }
  const subtitle = node.kind === "person" ? "人物" : "公司/机构";
  hoverTip.style.borderColor = node.kind === "person" ? PERSON_COLOR : ORG_COLOR;
  hoverTip.style.maxWidth = "260px";
  hoverTip.textContent = "";
  hoverTip.innerHTML = `<div class="tipTitle">${escapeHtml(node.label)}</div><div class="tipSub">${escapeHtml(subtitle)}</div>`;
  hoverTip.hidden = false;
  placeTip(hoverTip, pointerState.clientX + 12, pointerState.clientY + 12);
}

function schedulePointerUpdate(ev) {
  const rect = canvas.getBoundingClientRect();
  pointerState.x = ev.clientX - rect.left;
  pointerState.y = ev.clientY - rect.top;
  pointerState.clientX = ev.clientX;
  pointerState.clientY = ev.clientY;
  pointerState.dirty = true;
  if (pointerRaf) return;
  pointerRaf = requestAnimationFrame(() => {
    pointerRaf = 0;
    if (!pointerState.dirty) return;
    pointerState.dirty = false;
    const n = pickNodeAt(pointerState.x, pointerState.y);
    hoveredId = n ? n.id : "";
    if (hoveredId !== lastHoverId) {
      lastHoverId = hoveredId;
      scheduleDraw();
    }
    setHoverTip(n);
    canvas.style.cursor = n ? "pointer" : isPanning ? "grabbing" : "default";
  });
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
  if (!showEdges && activeId) {
    const a = nodeById.get(activeId);
    const nb = neighbors.get(activeId);
    if (a && nb) {
      ctx.globalAlpha = 0.96;
      ctx.strokeStyle = EDGE_HL;
      ctx.lineWidth = 1.6 / view.k;
      for (const id of nb) {
        const b = nodeById.get(id);
        if (!b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
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
    if (isSelected || isHover) {
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.fillStyle = n.kind === "person" ? "rgba(66,133,244,0.95)" : "rgba(219,68,55,0.95)";
      ctx.arc(n.x, n.y, r * 2.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = isSelected || isHover ? 1 : baseAlpha;
    }
    ctx.beginPath();
    ctx.fillStyle = n.kind === "person" ? PERSON_COLOR : ORG_COLOR;
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.stroke();

    if (view.k > 0.9 && (isSelected || isHover || (hl && isHL))) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.font = `${11 / view.k}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      const prefix = n.kind === "person" ? "P · " : "O · ";
      const text = prefix + n.label;
      const tx = n.x + 9 / view.k;
      const ty = n.y + 4 / view.k;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const labelColor = n.kind === "person" ? "rgba(66,133,244,0.95)" : "rgba(219,68,55,0.9)";
      if (isHover) {
        const m = ctx.measureText(text);
        const padX = 6 / view.k;
        const boxH = 16 / view.k;
        const boxW = m.width + padX * 2;
        const boxX = tx - padX;
        const boxY = ty - boxH / 2;
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.strokeStyle = labelColor;
        ctx.lineWidth = 1.1 / view.k;
        roundRectPath(ctx, boxX, boxY, boxW, boxH, 8 / view.k);
        ctx.fill();
        ctx.globalAlpha = 0.22;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = alpha * (isHover ? 1 : 0.9);
      ctx.fillStyle = labelColor;
      ctx.fillText(text, tx, ty);
    }
  }

  ctx.restore();
  ctx.globalAlpha = 1;
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
    if (hoverTip) hoverTip.hidden = true;
    setFocusQuery("");
    scheduleDraw();
    return;
  }
  selectedId = n.id;
  setFocusQuery(n.id);
  showPopup(n, ev.clientX, ev.clientY);
  if (layoutMode === "radial") setRadialLayout();
  scheduleDraw();
}

function onDoubleClick(ev) {
  return;
}

function onMouseMove(ev) {
  schedulePointerUpdate(ev);
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
  scheduleDraw();
}

function onMouseDown(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const n = pickNodeAt(x, y);
  dragStart = { x: ev.clientX, y: ev.clientY, px: x, py: y, moved: false };
  if (hoverTip) hoverTip.hidden = true;
  if (n) {
    dragNodeId = n.id;
    canvas.style.cursor = "grabbing";
    scheduleDraw();
    return;
  }
  dragNodeId = "";
  isPanning = true;
  panStart = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  canvas.style.cursor = "grabbing";
  scheduleDraw();
}

function onMouseUp() {
  isPanning = false;
  dragNodeId = "";
  setTimeout(() => {
    dragStart.moved = false;
  }, 0);
  scheduleDraw();
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
    scheduleDraw();
    return;
  }

  if (!isPanning) return;
  view.x = panStart.vx + dxPage;
  view.y = panStart.vy + dyPage;
  scheduleDraw();
}

async function main() {
  resize();
  if (geoYearInput) {
    geoYear = parseInt(geoYearInput.value, 10);
    if (geoYearLabel) geoYearLabel.textContent = String(geoYear);
  }
  setGeoYearVisible(layoutMode === "geo");
  setShowEdges(showEdges);
  window.addEventListener("resize", debounce(() => {
    resize();
    setLayout();
  }, 120));

  setOverlayVisible(true, "加载中…", "正在加载关系数据");
  const data = await fetchJson(DATA_PATH);
  nodes = (data.nodes ?? []).map((n) => ({ ...n, x: 0, y: 0 }));
  edges = (data.edges ?? []).map((e) => ({ ...e }));
  buildIndex();
  computePageRank();
  setLayout();
  applyFocusFromQuery();
  if (layoutMode !== "force") setOverlayVisible(false);

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
      if (hoverTip) hoverTip.hidden = true;
      if (layoutMode === "radial") setRadialLayout();
      scheduleDraw();
    }, 160),
  );

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      selectedId = "";
      clearPopup();
      if (hoverTip) hoverTip.hidden = true;
      setFocusQuery("");
      scheduleDraw();
    }
    if (e.key === "/") {
      const tag = String(document.activeElement?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      searchInput?.focus();
    }
  });

  scheduleDraw();
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
  scheduleDraw();
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
  scheduleDraw();
});

toggleSidebarBtn?.addEventListener("click", () => {
  const collapsed = !!layoutRoot?.classList.contains("collapsed");
  setSidebarCollapsed(!collapsed);
});

main();
