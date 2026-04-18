import { debounce, fetchJson } from "./common.js";

const DATA_PATH = "../data/relations.json";

function normalizeText(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function colorForKind(kind) {
  if (kind === "person") return { fill: "rgba(34, 211, 238, 0.34)", stroke: "rgba(125, 211, 252, 0.95)" };
  if (kind === "org") return { fill: "rgba(99, 102, 241, 0.30)", stroke: "rgba(165, 180, 252, 0.9)" };
  if (kind === "investor") return { fill: "rgba(245, 158, 11, 0.30)", stroke: "rgba(253, 230, 138, 0.9)" };
  return { fill: "rgba(148, 163, 184, 0.22)", stroke: "rgba(148, 163, 184, 0.55)" };
}

function edgeColor(type) {
  if (type === "works_at") return "rgba(125, 211, 252, 0.38)";
  if (type === "founded") return "rgba(165, 180, 252, 0.45)";
  if (type === "invested") return "rgba(253, 230, 138, 0.45)";
  return "rgba(148, 163, 184, 0.38)";
}

function openMapForNode(node) {
  const kind = node.kind;
  const value = node.label ?? node.id;
  const url = new URL("./map.html", window.location.href);
  if (kind === "person") url.searchParams.set("focus", `person:${value}`);
  if (kind === "org") url.searchParams.set("focus", `org:${value}`);
  window.open(url.toString(), "_blank");
}

function resizeCanvas(canvas, dpr) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function stableSort(arr, keyFn) {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

function ringLayout(nodes, { baseRadius, spacing }) {
  if (!nodes.length) return;
  const r = Math.max(baseRadius, Math.round((nodes.length * spacing) / (2 * Math.PI)));
  for (let i = 0; i < nodes.length; i += 1) {
    const t = (i / nodes.length) * Math.PI * 2;
    nodes[i].x = Math.cos(t) * r;
    nodes[i].y = Math.sin(t) * r;
  }
}

function applyLayout(nodes) {
  const persons = stableSort(nodes.filter((n) => n.kind === "person"), (n) => String(n.label ?? n.id));
  const orgs = stableSort(nodes.filter((n) => n.kind === "org"), (n) => String(n.label ?? n.id));
  const investors = stableSort(nodes.filter((n) => n.kind === "investor"), (n) => String(n.label ?? n.id));
  const others = stableSort(nodes.filter((n) => !["person", "org", "investor"].includes(n.kind)), (n) => String(n.label ?? n.id));

  ringLayout(orgs, { baseRadius: 140, spacing: 14 });
  ringLayout(investors, { baseRadius: 220, spacing: 16 });
  ringLayout(persons, { baseRadius: 280, spacing: 16 });
  ringLayout(others, { baseRadius: 190, spacing: 14 });
}

function mainLoop({ canvas, ctx, nodes, edges, searchInput }) {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  const state = {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    draggingNode: null,
    draggingCanvas: false,
    dragStart: null,
    hoverNode: null,
    selectedNode: null,
  };

  function worldToScreen(p) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return {
      x: cx + (p.x + state.offsetX) * state.zoom,
      y: cy + (p.y + state.offsetY) * state.zoom,
    };
  }

  function screenToWorld(x, y) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return {
      x: (x - cx) / state.zoom - state.offsetX,
      y: (y - cy) / state.zoom - state.offsetY,
    };
  }

  function pickNode(screenX, screenY) {
    const p = screenToWorld(screenX, screenY);
    let best = null;
    let bestD2 = Infinity;
    for (const n of nodes) {
      const r = n.r / state.zoom;
      const d2 = (n.x - p.x) * (n.x - p.x) + (n.y - p.y) * (n.y - p.y);
      if (d2 <= r * r && d2 < bestD2) {
        best = n;
        bestD2 = d2;
      }
    }
    return best;
  }

  function centerOnNode(n) {
    state.offsetX = -n.x;
    state.offsetY = -n.y;
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(state.zoom, state.zoom);
    ctx.translate(state.offsetX, state.offsetY);

    ctx.lineWidth = 1 / state.zoom;
    for (const e of edges) {
      const a = e.a;
      const b = e.b;
      ctx.strokeStyle = e.color;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const n of nodes) {
      const c = n.color;
      const selected = state.selectedNode && state.selectedNode.id === n.id;
      const hovered = state.hoverNode && state.hoverNode.id === n.id;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = c.fill;
      ctx.fill();
      ctx.lineWidth = (selected ? 3 : hovered ? 2 : 1.2) / state.zoom;
      ctx.strokeStyle = selected ? "rgba(255,255,255,0.9)" : c.stroke;
      ctx.stroke();
    }

    const labelNode = state.hoverNode || state.selectedNode;
    if (labelNode) {
      const s = worldToScreen(labelNode);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const text = `${labelNode.label}`;
      ctx.font = "13px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial";
      const pad = 8;
      const w = Math.min(canvas.width - 20, ctx.measureText(text).width + pad * 2);
      const h = 28;
      const x = clamp(s.x - w / 2, 10, canvas.width - w - 10);
      const y = clamp(s.y - 44, 10, canvas.height - h - 10);
      ctx.fillStyle = "rgba(11,16,32,0.92)";
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, 10);
      } else {
        ctx.rect(x, y, w, h);
      }
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(230,237,243,0.92)";
      ctx.fillText(text, x + pad, y + 18);
    }
  }

  let raf = 0;
  function scheduleDraw() {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      resizeCanvas(canvas, dpr);
      draw();
    });
  }

  const onMove = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    state.hoverNode = pickNode(x * dpr, y * dpr);
    if (state.draggingNode) {
      const p = screenToWorld(x * dpr, y * dpr);
      state.draggingNode.x = p.x;
      state.draggingNode.y = p.y;
      return;
    }
    if (state.draggingCanvas && state.dragStart) {
      const dx = (x * dpr - state.dragStart.x) / state.zoom;
      const dy = (y * dpr - state.dragStart.y) / state.zoom;
      state.offsetX = state.dragStart.offsetX + dx;
      state.offsetY = state.dragStart.offsetY + dy;
    }
    scheduleDraw();
  };

  const onDown = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * dpr;
    const y = (evt.clientY - rect.top) * dpr;
    const hit = pickNode(x, y);
    if (hit) {
      state.selectedNode = hit;
      state.draggingNode = hit;
      return;
    }
    state.selectedNode = null;
    state.draggingCanvas = true;
    state.dragStart = { x, y, offsetX: state.offsetX, offsetY: state.offsetY };
    scheduleDraw();
  };

  const onUp = () => {
    state.draggingNode = null;
    state.draggingCanvas = false;
    state.dragStart = null;
    scheduleDraw();
  };

  const onWheel = (evt) => {
    evt.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * dpr;
    const y = (evt.clientY - rect.top) * dpr;
    const before = screenToWorld(x, y);
    const delta = -evt.deltaY;
    const factor = delta > 0 ? 1.08 : 1 / 1.08;
    const nextZoom = clamp(state.zoom * factor, 0.25, 3.2);
    state.zoom = nextZoom;
    const after = screenToWorld(x, y);
    state.offsetX += after.x - before.x;
    state.offsetY += after.y - before.y;
    scheduleDraw();
  };

  const onDblClick = () => {
    const n = state.selectedNode || state.hoverNode;
    if (!n) return;
    openMapForNode(n);
  };

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDblClick);

  const search = debounce(() => {
    const q = normalizeText(searchInput.value);
    if (!q) return;
    const hit = nodes.find((n) => normalizeText(n.label).includes(q) || normalizeText(n.id).includes(q));
    if (!hit) return;
    state.selectedNode = hit;
    centerOnNode(hit);
    state.zoom = 1.2;
    scheduleDraw();
  }, 120);

  searchInput.addEventListener("input", search);

  window.addEventListener("resize", () => scheduleDraw());
  centerOnNode(nodes[0] ?? { x: 0, y: 0 });
  scheduleDraw();
}

async function main() {
  const canvas = document.getElementById("graphCanvas");
  const ctx = canvas.getContext("2d");
  const searchInput = document.getElementById("searchInput");

  const raw = await fetchJson(DATA_PATH);
  const rawNodes = raw.nodes ?? [];
  const rawEdges = raw.edges ?? [];

  const nodes = rawNodes.map((n, idx) => {
    const kind = n.kind ?? "node";
    const c = colorForKind(kind);
    const r = kind === "person" ? 11 : kind === "org" ? 9 : 10;
    return {
      id: n.id,
      label: n.label ?? n.id,
      kind,
      color: c,
      x: (Math.random() - 0.5) * 600 + (idx % 9) * 6,
      y: (Math.random() - 0.5) * 420 + (idx % 7) * 6,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      r,
      mass: kind === "person" ? 1.2 : 1,
    };
  });
  applyLayout(nodes);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = rawEdges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return null;
      return { a, b, type: e.type ?? "", color: edgeColor(e.type) };
    })
    .filter(Boolean);

  mainLoop({ canvas, ctx, nodes, edges, searchInput });
}

main().catch((e) => {
  const root = document.getElementById("graph");
  root.textContent = String(e?.message ?? e);
});
