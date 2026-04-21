import { clamp, debounce, fetchJson, getQueryParam, groupBy, setQueryParam, sortBy } from "./common.js";

const DATA_PATH = "../data/movements.geojson";
const YEAR_RANGE = { min: 2000, max: 2026 };
const DEFAULT_VIEW = { center: [30, 120], zoom: 3 };
const COLOR_CYAN = "rgba(0, 220, 255, 0.95)";
const COLOR_CYAN_SOFT = "rgba(0, 220, 255, 0.55)";
const COLOR_PURPLE = "rgba(160, 110, 255, 0.92)";
const COLOR_GOLD = "rgba(255, 200, 80, 0.98)";

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

const map = new AMap.Map("map", {
  zoom: DEFAULT_VIEW.zoom,
  center: [DEFAULT_VIEW.center[1], DEFAULT_VIEW.center[0]], // [lon, lat]
  mapStyle: "amap://styles/dark",
  viewMode: "3D",
});

map.setPitch(55);
map.setRotation(20);

const loca = new Loca.Container({ map });
const scatterLayer = new Loca.ScatterLayer({ loca, zIndex: 200 });
const pulseLineLayer = new Loca.PulseLineLayer({ loca, zIndex: 110 });
const highlightLineLayer = new Loca.PulseLineLayer({ loca, zIndex: 111 });

let infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -10) });

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
let selectedPersonId = "";
let hoverPersonId = "";
let edgeSourceUrl = "";
let edgeSource = null;
const movementSource = new Loca.GeoJSONSource({ url: DATA_PATH });

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

function extractPickedFeature(res) {
  if (!res) return null;
  if (res.feature) return res.feature;
  if (res.rawData) return res.rawData;
  if (res.data) return res.data;
  if (res.properties && res.geometry) return res;
  return null;
}

function ensureEdgeSource() {
  if (edgeSource) return;
  const edgeFeatures = allEdges.map((e) => {
    const from = e.from;
    const to = e.to;
    const [fromLon, fromLat] = from.geometry.coordinates;
    const [toLon, toLat] = to.geometry.coordinates;
    const pts = greatCircle(fromLat, fromLon, toLat, toLon, 36);
    return {
      type: "Feature",
      properties: {
        person_id: e.person_id,
        person_name: to.properties.person_name ?? "",
        org_name: to.properties.org_name ?? "",
        city: to.properties.city ?? "",
        country: to.properties.country ?? "",
        from_year: Number(from.properties.year),
        to_year: Number(to.properties.year),
      },
      geometry: {
        type: "LineString",
        coordinates: pts.map((p) => [p[1], p[0]]),
      },
    };
  });

  const fc = { type: "FeatureCollection", features: edgeFeatures };
  edgeSourceUrl = URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: "application/json" }));
  edgeSource = new Loca.GeoJSONSource({ url: edgeSourceUrl });
}

function applyLocaStyles() {
  const y = currentYear();
  const filter = currentFilter();
  const activePersonId = hoverPersonId || selectedPersonId;

  scatterLayer.setSource(movementSource, {
    unit: "px",
    size: (i, f) => {
      const year = Number(f.properties?.year);
      if (year !== y) return [0, 0];
      if (!matchesFilter(f, filter)) return [0, 0];
      const pid = String(f.properties?.person_id ?? "");
      if (activePersonId && pid === activePersonId) return [14, 14];
      return [10, 10];
    },
    color: (i, f) => {
      const year = Number(f.properties?.year);
      if (year !== y) return "rgba(0,0,0,0)";
      if (!matchesFilter(f, filter)) return "rgba(0,0,0,0)";
      const pid = String(f.properties?.person_id ?? "");
      if (activePersonId && pid === activePersonId) return COLOR_GOLD;
      return COLOR_CYAN;
    },
    borderWidth: (i, f) => {
      const year = Number(f.properties?.year);
      if (year !== y) return 0;
      if (!matchesFilter(f, filter)) return 0;
      const pid = String(f.properties?.person_id ?? "");
      if (activePersonId && pid === activePersonId) return 2;
      return 1;
    },
    borderColor: "rgba(255, 255, 255, 0.85)",
    opacity: (i, f) => {
      const year = Number(f.properties?.year);
      if (year !== y) return 0;
      if (!matchesFilter(f, filter)) return 0;
      return 1;
    },
  });

  ensureEdgeSource();

  pulseLineLayer.setSource(edgeSource, {
    opacity: (i, f) => {
      const toYear = Number(f.properties?.to_year);
      if (toYear !== y) return 0;
      if (!matchesFilter(f, filter)) return 0;
      return 0.78;
    },
    lineWidth: 2.6,
    color: (i, f) => {
      const pid = String(f.properties?.person_id ?? "");
      if (activePersonId && pid === activePersonId) return COLOR_CYAN;
      return COLOR_PURPLE;
    },
    speed: 1.35,
  });

  highlightLineLayer.setSource(edgeSource, {
    opacity: (i, f) => {
      const toYear = Number(f.properties?.to_year);
      if (toYear !== y) return 0;
      if (!matchesFilter(f, filter)) return 0;
      if (!activePersonId) return 0;
      const pid = String(f.properties?.person_id ?? "");
      return pid === activePersonId ? 1 : 0;
    },
    lineWidth: 5.2,
    color: COLOR_GOLD,
    speed: 1.8,
  });

  loca.requestRender();
}

function render() {
  const y = currentYear();
  const filter = currentFilter();
  setQueryParam("year", String(y));
  setQueryParam("q", filter || "");

  const visible = allFeatures.filter((f) => f.properties.year === y).filter((f) => matchesFilter(f, filter));
  yearLabelEl.textContent = String(y);
  countLabelEl.textContent = `${visible.length} 节点`;

  applyLocaStyles();
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
  loca.animate.start();
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

map.on("mousemove", (e) => {
  const res = scatterLayer.queryFeature([e.pixel.x, e.pixel.y]);
  const f = extractPickedFeature(res);
  const next = f ? String(f.properties?.person_id ?? "") : "";
  if (next !== hoverPersonId) {
    hoverPersonId = next;
    applyLocaStyles();
  }
});

map.on("click", (e) => {
  const res = scatterLayer.queryFeature([e.pixel.x, e.pixel.y]);
  const f = extractPickedFeature(res);
  if (!f) return;
  const p = f.properties ?? {};
  const y = currentYear();
  const pid = String(p.person_id ?? "");
  if (pid) {
    selectedPersonId = pid;
    setQueryParam("focus", `person:${pid}`);
    applyLocaStyles();
  }
  const [lon, lat] = f.geometry.coordinates ?? [];
  infoWindow.setContent(makePopupHtml(p, y));
  infoWindow.open(map, [lon, lat]);
});

main().catch((e) => {
  yearLabelEl.textContent = "加载失败";
  countLabelEl.textContent = String(e?.message ?? e);
});
