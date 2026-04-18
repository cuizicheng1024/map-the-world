import { clamp, debounce, fetchJson, getQueryParam, groupBy, setQueryParam, sortBy } from "./common.js";

const DATA_PATH = "../data/movements.geojson";
const YEAR_RANGE = { min: 2000, max: 2026 };
const DEFAULT_MARKER_SIZE = 8;
const DEFAULT_LINE_OPACITY = 0.55;

function normalizeText(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function matchesFilter(feature, filter) {
  if (!filter) return true;
  const f = normalizeText(filter);
  const p = feature.properties ?? {};
  const hay = [
    p.person_name,
    p.person_id,
    p.org_name,
    p.org_id,
    p.city,
    p.country,
    p.role,
  ]
    .map(normalizeText)
    .join(" | ");
  return hay.includes(f);
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function greatCircle(lat1, lon1, lat2, lon2, steps) {
  const φ1 = toRad(lat1);
  const λ1 = toRad(lon1);
  const φ2 = toRad(lat2);
  const λ2 = toRad(lon2);

  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinλ1 = Math.sin(λ1);
  const cosλ1 = Math.cos(λ1);
  const sinφ2 = Math.sin(φ2);
  const cosφ2 = Math.cos(φ2);
  const sinλ2 = Math.sin(λ2);
  const cosλ2 = Math.cos(λ2);

  const x1 = cosφ1 * cosλ1;
  const y1 = cosφ1 * sinλ1;
  const z1 = sinφ1;
  const x2 = cosφ2 * cosλ2;
  const y2 = cosφ2 * sinλ2;
  const z2 = sinφ2;

  const dot = x1 * x2 + y1 * y2 + z1 * z2;
  const ω = Math.acos(clamp(dot, -1, 1));
  const sinω = Math.sin(ω);

  if (!isFinite(ω) || sinω === 0) {
    return [
      [lat1, lon1],
      [lat2, lon2],
    ];
  }

  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const A = Math.sin((1 - t) * ω) / sinω;
    const B = Math.sin(t * ω) / sinω;
    const x = A * x1 + B * x2;
    const y = A * y1 + B * y2;
    const z = A * z1 + B * z2;
    const φ = Math.atan2(z, Math.hypot(x, y));
    const λ = Math.atan2(y, x);
    pts.push([toDeg(φ), toDeg(λ)]);
  }
  return pts;
}

function buildStoryEdges(features) {
  const byPerson = groupBy(features, (f) => f.properties.person_id);
  const edges = [];
  for (const [personId, items] of byPerson.entries()) {
    const sorted = sortBy(items, (f) => f.properties.year);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      edges.push({
        person_id: personId,
        from: prev,
        to: curr,
      });
    }
  }
  return edges;
}

function makePopupHtml(p, year) {
  const parts = [];
  parts.push(`<div style="font-weight:700; margin-bottom: 6px;">${p.person_name ?? p.person_id ?? "—"}</div>`);
  parts.push(`<div style="opacity:.9">${p.org_name ?? p.org_id ?? "—"}</div>`);
  parts.push(`<div style="opacity:.8; margin-top: 4px;">${p.city ?? "—"}${p.country ? ` · ${p.country}` : ""}</div>`);
  parts.push(`<div style="opacity:.75; margin-top: 6px;">${year}${p.role ? ` · ${p.role}` : ""}</div>`);
  if (p.source) {
    parts.push(`<div style="opacity:.7; margin-top: 6px; font-size: 12px;">${p.source}</div>`);
  }
  return parts.join("");
}

const map = L.map("map", {
  zoomControl: true,
  worldCopyJump: true,
}).setView([25, 0], 2);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const lineLayer = L.layerGroup().addTo(map);

const yearLabelEl = document.getElementById("yearLabel");
const countLabelEl = document.getElementById("countLabel");
const yearSliderEl = document.getElementById("yearSlider");
const minYearEl = document.getElementById("minYear");
const maxYearEl = document.getElementById("maxYear");
const filterInputEl = document.getElementById("filterInput");
const playBtnEl = document.getElementById("playBtn");
const pauseBtnEl = document.getElementById("pauseBtn");
const playSpeedEl = document.getElementById("playSpeed");

let allFeatures = [];
let allEdges = [];
let minYear = 0;
let maxYear = 0;
let playing = false;
let playTimer = null;

function getFocusFilterFromQuery() {
  const focus = getQueryParam("focus");
  if (!focus) return "";
  const [kind, id] = focus.split(":");
  if (!kind || !id) return "";
  if (kind === "person") return id;
  if (kind === "org") return id;
  return id;
}

function applyFilterFromQuery() {
  const f = getFocusFilterFromQuery();
  if (f) {
    filterInputEl.value = f;
  }
}

function setYearFromQueryOrDefault() {
  const y = Number(getQueryParam("year"));
  const init = Number.isFinite(y) ? y : Number(yearSliderEl.value);
  const clamped = clamp(init, minYear, maxYear);
  yearSliderEl.value = String(clamped);
}

function currentYear() {
  return Number(yearSliderEl.value);
}

function currentFilter() {
  return filterInputEl.value.trim();
}

function render() {
  const y = currentYear();
  const filter = currentFilter();
  setQueryParam("year", String(y));
  setQueryParam("q", filter || "");

  markerLayer.clearLayers();
  lineLayer.clearLayers();

  const visible = allFeatures.filter((f) => f.properties.year === y).filter((f) => matchesFilter(f, filter));
  const visibleIds = new Set(visible.map((f) => `${f.properties.person_id}::${f.properties.year}`));
  const markerSize = DEFAULT_MARKER_SIZE;
  const lineOpacity = DEFAULT_LINE_OPACITY;

  for (const f of visible) {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const m = L.circleMarker([lat, lon], {
      radius: markerSize,
      color: "rgba(125, 211, 252, 0.9)",
      weight: 1,
      fillColor: "rgba(34, 211, 238, 0.35)",
      fillOpacity: 1,
    });
    m.bindPopup(makePopupHtml(p, y));
    m.addTo(markerLayer);
  }

  for (const e of allEdges) {
    const from = e.from;
    const to = e.to;
    if (to.properties.year !== y) continue;
    if (!visibleIds.has(`${to.properties.person_id}::${to.properties.year}`)) continue;
    if (!matchesFilter(to, filter)) continue;

    const [fromLon, fromLat] = from.geometry.coordinates;
    const [toLon, toLat] = to.geometry.coordinates;
    const pts = greatCircle(fromLat, fromLon, toLat, toLon, 36);
    const poly = L.polyline(
      pts.map((p) => [p[0], p[1]]),
      {
        color: `rgba(125, 211, 252, ${lineOpacity})`,
        weight: 2,
        opacity: 1,
      }
    );
    poly.addTo(lineLayer);
  }

  yearLabelEl.textContent = String(y);
  countLabelEl.textContent = `${visible.length} 节点`;
}

function stopPlaying() {
  playing = false;
  if (playTimer) window.clearInterval(playTimer);
  playTimer = null;
}

function startPlaying() {
  stopPlaying();
  playing = true;
  const tick = () => {
    const speed = Number(playSpeedEl.value);
    const y = currentYear();
    const next = y >= maxYear ? minYear : y + 1;
    yearSliderEl.value = String(next);
    render();
    if (!playing) return;
    if (playTimer) window.clearInterval(playTimer);
    playTimer = window.setInterval(tick, Math.max(120, Math.round(1000 / speed)));
  };
  playTimer = window.setInterval(tick, Math.max(120, Math.round(1000 / Number(playSpeedEl.value))));
}

async function main() {
  const geo = await fetchJson(DATA_PATH);
  const features = (geo.features ?? []).filter((f) => f?.geometry?.type === "Point");
  allFeatures = features.map((f) => ({
    ...f,
    properties: {
      ...f.properties,
      year: Number(f.properties.year),
    },
  }));

  const years = allFeatures.map((f) => f.properties.year).filter((y) => Number.isFinite(y));
  minYear = Math.min(YEAR_RANGE.min, ...years);
  maxYear = Math.max(YEAR_RANGE.max, ...years);
  allEdges = buildStoryEdges(allFeatures);

  yearSliderEl.min = String(minYear);
  yearSliderEl.max = String(maxYear);
  minYearEl.textContent = String(minYear);
  maxYearEl.textContent = String(maxYear);

  applyFilterFromQuery();
  const q = getQueryParam("q");
  if (q && !filterInputEl.value) filterInputEl.value = q;

  setYearFromQueryOrDefault();
  render();
}

yearSliderEl.addEventListener("input", () => {
  stopPlaying();
  render();
});

filterInputEl.addEventListener(
  "input",
  debounce(() => {
    stopPlaying();
    render();
  }, 120)
);

playBtnEl.addEventListener("click", () => startPlaying());
pauseBtnEl.addEventListener("click", () => stopPlaying());

playSpeedEl.addEventListener("input", () => {
  if (playing) startPlaying();
});

main().catch((e) => {
  yearLabelEl.textContent = "加载失败";
  countLabelEl.textContent = String(e?.message ?? e);
});
