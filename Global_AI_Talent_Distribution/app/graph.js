import { debounce, fetchJson } from "./common.js";

const DATA_PATH = "../data/relations.json";

function normalizeText(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function colorForKind(kind) {
  if (kind === "person") return { fill: "rgba(34, 211, 238, 0.34)", stroke: "rgba(125, 211, 252, 0.95)" };
  return { fill: "rgba(34, 211, 238, 0.34)", stroke: "rgba(125, 211, 252, 0.95)" };
}

function edgeColor(type) {
  if (type === "co_worked") return "rgba(125, 211, 252, 0.32)";
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
  const persons = stableSort(nodes, (n) => String(n.label ?? n.id));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spacing = 12;
  for (let i = 0; i < persons.length; i += 1) {
    const r = spacing * Math.sqrt(i);
    const t = i * golden;
    persons[i].x = Math.cos(t) * r;
    persons[i].y = Math.sin(t) * r;
  }
}

function buildPeopleEdgesFromRelations(raw, { maxDegree, maxEdges, minWeight }) {
  const people = new Set((raw.nodes ?? []).filter((n) => n?.kind === "person").map((n) => n.id));
  const orgToPeople = new Map();
  for (const e of raw.edges ?? []) {
    if (!e || e.type !== "works_at") continue;
    if (!people.has(e.from)) continue;
    const org = e.to;
    if (!org) continue;
    if (!orgToPeople.has(org)) orgToPeople.set(org, new Set());
    orgToPeople.get(org).add(e.from);
  }

  const weights = new Map();
  const addWeight = (a, b) => {
    const k = a < b ? `${a}||${b}` : `${b}||${a}`;
    weights.set(k, (weights.get(k) ?? 0) + 1);
  };

  for (const set of orgToPeople.values()) {
    const ps = Array.from(set);
    if (ps.length < 2) continue;
    ps.sort();
    for (let i = 0; i < ps.length; i += 1) {
      for (let j = i + 1; j < ps.length; j += 1) {
        addWeight(ps[i], ps[j]);
      }
    }
  }

  let edgeList = [];
  for (const [k, w] of weights.entries()) {
    if (w < minWeight) continue;
    const [a, b] = k.split("||");
    edgeList.push([a, b, w]);
  }
  edgeList.sort((x, y) => y[2] - x[2] || x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));

  const degrees = new Map();
  const chosen = [];
  const degreeOf = (id) => degrees.get(id) ?? 0;
  const inc = (id) => degrees.set(id, degreeOf(id) + 1);

  for (const [a, b, w] of edgeList) {
    if (chosen.length >= maxEdges) break;
    if (degreeOf(a) >= maxDegree || degreeOf(b) >= maxDegree) continue;
    chosen.push({ from: a, to: b, type: "co_worked", label: `共同任职×${w}`, color: edgeColor("co_worked") });
    inc(a);
    inc(b);
  }

  if (chosen.length < 60 && minWeight > 1) {
    return buildPeopleEdgesFromRelations(raw, { maxDegree, maxEdges, minWeight: 1 });
  }

  return { people, edges: chosen };
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

  const { people, edges: derivedEdges } = buildPeopleEdgesFromRelations(raw, { maxDegree: 16, maxEdges: 900, minWeight: 2 });
  const nodes = rawNodes
    .filter((n) => people.has(n.id))
    .map((n, idx) => {
    const kind = "person";
    const c = colorForKind(kind);
    const r = 10;
    return {
      id: n.id,
      label: n.label ?? n.id,
      kind,
      color: c,
      x: (Math.random() - 0.5) * 40 + (idx % 9) * 2,
      y: (Math.random() - 0.5) * 40 + (idx % 7) * 2,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      r,
      mass: 1,
    };
    });
  applyLayout(nodes);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = derivedEdges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return null;
      return { a, b, type: e.type, color: e.color };
    })
    .filter(Boolean);

  mainLoop({ canvas, ctx, nodes, edges, searchInput });
}

main().catch((e) => {
  const root = document.getElementById("graph");
  root.textContent = String(e?.message ?? e);
});
