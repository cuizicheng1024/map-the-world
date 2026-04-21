import { getQueryParam } from "./common.js";

const DEFAULT_VIEW = { lon: 116.4, lat: 39.9, height: 1e7 };
const COLOR_CYAN = new Cesium.Color(0.0, 0.86, 1.0, 0.95);
const COLOR_PURPLE = new Cesium.Color(0.63, 0.43, 1.0, 0.92);
const COLOR_GOLD = new Cesium.Color(1.0, 0.78, 0.31, 0.98);

let viewer, dataSource, allEntities = [], currentYear = 2023, playTimer, playSpeed = 2;
const yearSlider = document.getElementById("yearSlider");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const speedSlider = document.getElementById("playSpeed");
const filterInput = document.getElementById("filterInput");

async function loadData() {
  dataSource = await Cesium.GeoJsonDataSource.load("../data/movements.geojson", {
    stroke: Cesium.Color.WHITE.withAlpha(0.5),
    strokeWidth: 1.2,
    fill: COLOR_CYAN,
    markerSize: 6,
  });
  viewer.dataSources.add(dataSource);
  allEntities = [...dataSource.entities.values];
  allEntities.forEach((e) => {
    const p = e.properties;
    e._year = p.year?.getValue();
    e._person = p.person_name?.getValue();
    e._org = p.org_name?.getValue();
    e._city = p.city?.getValue();

    if (e.billboard) e.billboard = undefined;
    e.point = new Cesium.PointGraphics({
      pixelSize: 8,
      color: COLOR_CYAN,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
      outlineWidth: 1,
    });
  });
  applyYearFilter();
  applyFocusFilter();
  zoomToVisible();
}

function initViewer() {
  viewer = new Cesium.Viewer("cesiumContainer", {
    imageryProvider: new Cesium.UrlTemplateImageryProvider({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    }),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    vrButton: false,
  });
  viewer.scene.globe.enableLighting = true;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(DEFAULT_VIEW.lon, DEFAULT_VIEW.lat, DEFAULT_VIEW.height),
  });
  loadData();
}

function applyYearFilter() {
  allEntities.forEach((e) => {
    e.show = e._year === currentYear;
  });
}

function applyFocusFilter() {
  const focus = getQueryParam("focus");
  if (!focus) return;
  const [type, keyword] = focus.split(":");
  if (!keyword) return;
  const kw = keyword.toLowerCase();
  allEntities.forEach((e) => {
    if (!e.show) return;
    const match =
      (type === "person" && e._person?.toLowerCase().includes(kw)) ||
      (type === "org" && e._org?.toLowerCase().includes(kw)) ||
      (type === "city" && e._city?.toLowerCase().includes(kw));
    if (!match) e.show = false;
  });
}

function zoomToVisible() {
  const visible = allEntities.filter((e) => e.show);
  if (!visible.length) return;
  viewer.zoomTo(dataSource);
}

function play() {
  if (playTimer) return;
  playBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  playTimer = setInterval(() => {
    currentYear += 1;
    if (currentYear > 2026) currentYear = 1912;
    yearSlider.value = currentYear;
    applyYearFilter();
    applyFocusFilter();
    zoomToVisible();
  }, 1000 / playSpeed);
}

function pause() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  playBtn.style.display = "inline-block";
  pauseBtn.style.display = "none";
}

yearSlider.addEventListener("input", (e) => {
  currentYear = parseInt(e.target.value, 10);
  applyYearFilter();
  applyFocusFilter();
  zoomToVisible();
});

speedSlider.addEventListener("input", (e) => {
  playSpeed = parseFloat(e.target.value);
  if (playTimer) {
    pause();
    play();
  }
});

filterInput.addEventListener("input", (e) => {
  const kw = e.target.value.trim();
  if (!kw) {
    applyYearFilter();
    applyFocusFilter();
    zoomToVisible();
    return;
  }
  const q = kw.toLowerCase();
  allEntities.forEach((en) => {
    if (en._year !== currentYear) {
      en.show = false;
      return;
    }
    const m =
      en._person?.toLowerCase().includes(q) ||
      en._org?.toLowerCase().includes(q) ||
      en._city?.toLowerCase().includes(q);
    en.show = !!m;
  });
  zoomToVisible();
});

playBtn.addEventListener("click", play);
pauseBtn.addEventListener("click", pause);
pauseBtn.style.display = "none";

initViewer();
