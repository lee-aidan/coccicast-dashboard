/* CocciCast dashboard
 * Reads data/forecast.json (produced by build/02_build_dashboard_data.py) and
 * renders a MapLibre GL county choropleth + Chart.js statewide trend.
 * MapLibre GL is the open, token-free Mapbox GL engine, so nothing secret is
 * embedded in this public page. */

const COUNTIES_GEOJSON =
  "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/california-counties.geojson";

const BASEMAP = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
        "https://b.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
        "https://c.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/* California sits UNDER the county choropleth (added before county-fill);
 * neighboring states are HTML markers that ride on top of the grey basemap. */
const CA_LABEL_POINT = [-119.4, 36.9];
/* statewide camera frame — used both for the initial fit and for returning from
 * a single-county drill-down */
const CA_BOUNDS = [[-124.55, 32.45], [-114.0, 42.05]];
const CA_PADDING = { top: 60, bottom: 80, left: 35, right: 30 };
const STATE_LABELS = [
  { coords: [-116.2, 39.2], name: "Nevada" },
  { coords: [-121.0, 43.6], name: "Oregon" },
  { coords: [-112.8, 34.1], name: "Arizona" },
];

/* sequential yellow -> red (ColorBrewer YlOrRd), grey for zero / no-data */
const RAMP = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"];
/* diverging blue -> white -> red (ColorBrewer RdBu, reversed) for the year-over-
 * year % change metric: deep blue = big decline, white = no change, dark red =
 * big increase */
const RAMP_DIV = ["#2166ac", "#67a9cf", "#ffffff", "#ef8a62", "#b2182b"];
const NA_COLOR = "#d9d9d9";

/* class breaks per metric over the 1-year forecast window: value falls into
 * class 0..4. Used by the map choropleth + legend and the summary stats.
 * pctchange breaks center each class on a labeled legend anchor
 * (-100, -50, 0, 50, 100). */
const YEAR_BREAKS = {
  incidence: [12, 36, 84, 180],
  cases: [60, 300, 900, 2400],
  pctchange: [-75, -25, 25, 75],
};
const METRIC_LABEL = {
  incidence: "1-Year Forecasted Incidence per 100k",
  cases: "1-Year Forecasted Cases",
  pctchange: "1-Year % Change vs. Prior Year",
};
function rampFor(metric) {
  return metric === "pctchange" ? RAMP_DIV : RAMP;
}
// Component-model names reflect what each model actually is in the pipeline
// (see scripts/06_CocciCast_Functions.R): m1-m4 are GLMs distinguished by their
// climate/drought terms, m5 is a random forest. "ensemble" is the weighted blend.
const MODEL_LABEL = {
  ensemble: "Ensemble",
  m1: "Drought-Interaction GLM",
  m2: "Baseline Seasonal GLM",
  m3: "Climate GLM",
  m4: "Seasonal-Climate GLM",
  m5: "Random Forest",
};

const state = {
  data: null,
  byCounty: new Map(), // name -> county record
  model: "ensemble",
  metric: "cases",
  nameToFeatureId: new Map(),
  mapReady: false,
  selectedCounty: null, // county name when drilled into a single-county view
  yearsBack: 2, // years of history shown in the trend chart (1 | 2 | 5 | 10)
};

const el = {
  modelSelect: document.getElementById("modelSelect"),
  metricSelect: document.getElementById("metricSelect"),
  lastUpdated: document.getElementById("lastUpdated"),
  mapLegend: document.getElementById("mapLegend"),
  legendTitle: document.getElementById("legendTitle"),
  legendList: document.getElementById("legendList"),
  summaryTitle: document.getElementById("summaryTitle"),
  chartTitle: document.getElementById("chartTitle"),
  legendForecastLabel: document.getElementById("legendForecastLabel"),
  legObsLabel: document.getElementById("legObsLabel"),
  legPred: document.getElementById("legPred"),
  legBand: document.getElementById("legBand"),
  casesStat: document.getElementById("casesStat"),
  casesSub: document.getElementById("casesSub"),
  incidenceStat: document.getElementById("incidenceStat"),
  incidenceLabel: document.getElementById("incidenceLabel"),
  highRiskStat: document.getElementById("highRiskStat"),
  highRiskLabel: document.getElementById("highRiskLabel"),
  highRiskSub: document.getElementById("highRiskSub"),
  mapBack: document.getElementById("mapBack"),
  specsLink: document.getElementById("specsLink"),
  specsClose: document.getElementById("specsClose"),
  leftFlip: document.getElementById("leftFlip"),
  flipInner: document.getElementById("flipInner"),
  summaryPanel: document.querySelector(".summary"),
  rangeSelect: document.getElementById("rangeSelect"),
};

let map, popup, pinnedPopup, chart;
let countiesGeo = null; // county FeatureCollection with stable, pre-assigned ids

init();

async function init() {
  // Fetch the forecast data and the county geometry in parallel. We load the
  // geometry ourselves (rather than letting MapLibre fetch it from the source
  // URL) so we can assign stable feature ids and build the name->id index up
  // front — the choropleth can then be painted by id the instant the county
  // source loads, without waiting on `idle` (which is gated by slow basemap
  // tiles) or on `querySourceFeatures` (which only sees tiled features).
  const [data, geo] = await Promise.all([
    fetch("./data/forecast.json").then((r) => r.json()),
    loadCountyGeometry(),
  ]);
  state.data = data;
  countiesGeo = geo;
  data.counties.forEach((c) => state.byCounty.set(c.name, c));

  const unmatched = state.data.counties
    .map((c) => c.name)
    .filter((n) => !state.nameToFeatureId.has(n));
  if (unmatched.length) console.warn("counties not matched in geojson:", unmatched);

  hydrateMeta();
  buildModelOptions();
  bindControls();
  buildMap();
  initChart();
  render();
  tourInit();
  maybeStartTour();
}

async function loadCountyGeometry() {
  const geo = await fetch(COUNTIES_GEOJSON).then((r) => r.json());
  geo.features.forEach((f, i) => {
    f.id = i; // explicit, stable id so setFeatureState never needs querySourceFeatures
    const name = f.properties?.name;
    if (name != null) state.nameToFeatureId.set(name, i);
  });
  return geo;
}

function hydrateMeta() {
  const m = state.data.meta;
  el.lastUpdated.textContent = fmtFullDate(m.generated);
}

function buildModelOptions() {
  // Ensemble sits on its own above the separator.
  const ens = document.createElement("option");
  ens.value = "ensemble";
  ens.textContent = MODEL_LABEL.ensemble;
  el.modelSelect.appendChild(ens);

  // A disabled "Component Models" row acts as a non-selectable header. Unlike an
  // <optgroup> (which native menus indent their children under), a plain disabled
  // <option> keeps the component model names left-aligned with "Ensemble".
  const header = document.createElement("option");
  header.disabled = true;
  header.textContent = "Component Models";
  el.modelSelect.appendChild(header);

  state.data.meta.models
    .filter((key) => key !== "ensemble")
    .forEach((key) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = MODEL_LABEL[key] ?? key;
      el.modelSelect.appendChild(opt);
    });
  el.modelSelect.value = state.model;
}

function bindControls() {
  el.modelSelect.addEventListener("change", (e) => {
    state.model = e.target.value;
    render();
    maybeAdvanceTourOnTarget("#modelSelect");
  });
  el.metricSelect.addEventListener("change", (e) => {
    state.metric = e.target.value;
    render();
    maybeAdvanceTourOnTarget("#metricSelect");
  });
  // chart history range: rebuild the visible window, keeping the 1-year forecast
  el.rangeSelect.addEventListener("change", (e) => {
    state.yearsBack = +e.target.value;
    rebuildChartRange();
    maybeAdvanceTourOnTarget("#rangeSelect");
  });
  // exit the single-county view: the on-map "back" pill or the Escape key
  el.mapBack.addEventListener("click", exitCounty);

  // model-specs flip panel: the "here" link opens it, the ✕ closes it
  el.specsLink.addEventListener("click", (e) => {
    e.preventDefault();
    openSpecs();
    maybeAdvanceTourOnTarget("#specsLink");
  });
  el.specsClose.addEventListener("click", closeSpecs);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (specsOpen) {
      closeSpecs();
    } else if (state.selectedCounty) {
      exitCounty();
    }
  });

  // keep the expanded panel sized to the map + summary if the window resizes
  window.addEventListener("resize", () => {
    if (specsOpen && el.leftFlip.classList.contains("is-expanded")) {
      el.flipInner.style.setProperty("--expand-right", `${specsExpandRight()}px`);
    }
  });
}

/* ---------- model-specs flip panel ----------
 * The left controls panel flips 180° to a "Model Specs" face, then widens
 * rightward to cover the map + statewide summary. The grid cell keeps its
 * column space, so nothing reflows underneath the overlay. */
let specsOpen = false;
let specsAnimating = false;
const FLIP_MS = 600;
const EXPAND_MS = 750;
const REVEAL_MS = 450; // matches the content fade/slide transition in styles.css

// how far the flip card's right edge must move (negative) to reach the summary's
// right edge — i.e. cover all three columns
function specsExpandRight() {
  const left = el.leftFlip.getBoundingClientRect().left;
  const right = el.summaryPanel.getBoundingClientRect().right;
  return Math.round(el.leftFlip.clientWidth - (right - left));
}

function openSpecs() {
  if (specsOpen || specsAnimating) return;
  specsOpen = true;
  specsAnimating = true;
  el.leftFlip.classList.add("is-active"); // lift above the map for the whole cycle
  el.leftFlip.classList.add("is-flipped"); // step 1: spin to the specs face
  window.setTimeout(() => {
    // step 2: widen over the map + summary once the flip has landed
    el.flipInner.style.setProperty("--expand-right", `${specsExpandRight()}px`);
    el.leftFlip.classList.add("is-expanded");
    window.setTimeout(() => {
      // step 3: fully flipped + expanded — now ease the content in
      el.leftFlip.classList.add("is-revealed");
      specsAnimating = false;
    }, EXPAND_MS);
  }, FLIP_MS);
}

function closeSpecs() {
  if (!specsOpen || specsAnimating) return;
  specsAnimating = true;
  // step 1: fade the content fully out before anything moves
  el.leftFlip.classList.remove("is-revealed");
  window.setTimeout(() => {
    // step 2: now that the content is gone, retract the width
    el.leftFlip.classList.remove("is-expanded");
    window.setTimeout(() => {
      el.leftFlip.classList.remove("is-flipped"); // step 3: flip back
      window.setTimeout(() => {
        // keep the z-index until the very end so the panel stays OVER the map
        // for the whole retract + flip-back
        el.leftFlip.classList.remove("is-active");
        specsOpen = false;
        specsAnimating = false;
      }, FLIP_MS);
    }, EXPAND_MS);
  }, REVEAL_MS);
}

/* ---------- metric helpers ---------- */
// the forecast year = the last 12 months of the series (the forecast horizon)
function forecastYearIndices() {
  const n = state.data.months.length;
  const indices = [];
  for (let i = Math.max(0, n - 12); i < n; i += 1) indices.push(i);
  return indices;
}

// 1-year aggregate the map shows: total forecasted cases (or incidence) over
// the forecast year, independent of the slider month
function countyYearValue(county, model, metric) {
  const series = county.cases[model];
  if (!series) return null;
  let sum = 0;
  let any = false;
  forecastYearIndices().forEach((i) => {
    const v = series[i];
    if (v != null) {
      sum += v;
      any = true;
    }
  });
  if (!any) return null;
  return metric === "cases" ? sum : (sum / county.pop) * 1e5;
}

// total predicted cases for a county over an explicit set of month indices
function sumCounty(county, model, indices) {
  const series = county.cases[model];
  if (!series) return null;
  let sum = 0;
  let any = false;
  indices.forEach((i) => {
    const v = series[i];
    if (v != null) {
      sum += v;
      any = true;
    }
  });
  return any ? sum : null;
}

// indices of the 12 months immediately before the forecast year (the prior year
// used for year-over-year comparisons)
function priorYearIndices() {
  const len = state.data.months.length;
  const idx = [];
  for (let i = Math.max(0, len - 24); i < len - 12; i += 1) idx.push(i);
  return idx;
}

// year-over-year % change in forecasted cases for a county: how the 1-year
// forecast compares to the prior 12 months. null when either side is missing or
// the prior year is zero (no meaningful ratio).
function countyPctChange(county, model) {
  const yearCases = countyYearValue(county, model, "cases");
  const prior = sumCounty(county, model, priorYearIndices());
  if (yearCases == null || prior == null || prior === 0) return null;
  return ((yearCases - prior) / prior) * 100;
}

// the value the choropleth paints for the active metric
function countyMapValue(county, model, metric) {
  if (metric === "pctchange") return countyPctChange(county, model);
  return countyYearValue(county, model, metric);
}

function classify(value, breaks) {
  if (value == null || value <= 0) return -1; // grey: no data / zero
  for (let i = 0; i < breaks.length; i += 1) if (value < breaks[i]) return i;
  return breaks.length;
}

// the choropleth fill expression for the active metric. cases/incidence use
// discrete classes (match on `cls`); % change uses a continuous diverging
// gradient interpolated on the raw value (`val`), greying out no-data counties.
function fillColorExpr(metric) {
  if (metric === "pctchange") {
    return [
      "case",
      ["==", ["feature-state", "hasVal"], true],
      [
        "interpolate",
        ["linear"],
        ["feature-state", "val"],
        -100, RAMP_DIV[0],
        -50, RAMP_DIV[1],
        0, RAMP_DIV[2],
        50, RAMP_DIV[3],
        100, RAMP_DIV[4],
      ],
      NA_COLOR,
    ];
  }
  const ramp = rampFor(metric);
  return [
    "match",
    ["feature-state", "cls"],
    0, ramp[0],
    1, ramp[1],
    2, ramp[2],
    3, ramp[3],
    4, ramp[4],
    NA_COLOR,
  ];
}

/* ---------- map ---------- */
function buildMap() {
  map = new maplibregl.Map({
    container: "map",
    style: BASEMAP,
    bounds: CA_BOUNDS,
    fitBoundsOptions: { padding: CA_PADDING },
    minZoom: 4,
    maxZoom: 9,
    maxBounds: [[-128, 30], [-110, 46]],
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: "imperial" }), "bottom-right");
  // the `bounds` option fits the camera synchronously at construction, so the
  // current zoom IS the load frame — lock it now as the max zoom-out (don't
  // wait for `idle`, which can be delayed by slow basemap tiles).
  map.setMinZoom(map.getZoom());
  syncZoomButtons();
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  // a second, persistent popup pinned over the selected county (name only)
  // anchor: "bottom" => the popup opens UPWARD from the county centroid; the
  // generous top fitBounds padding keeps the centroid low enough to clear the
  // top-right map legend
  pinnedPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: -6,
    anchor: "bottom",
    className: "popup-pinned",
  });

  map.on("load", () => {
    map.addSource("counties", {
      type: "geojson",
      data: countiesGeo, // in-memory, ids already assigned in loadCountyGeometry
    });
    map.addSource("caLabel", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: { type: "Point", coordinates: CA_LABEL_POINT },
        properties: { name: "California" },
      },
    });
    map.addLayer({
      id: "ca-label",
      type: "symbol",
      source: "caLabel",
      layout: {
        "text-field": "California",
        "text-font": ["Noto Sans Regular"],
        "text-size": 19,
        "text-letter-spacing": 0.18,
        "text-transform": "uppercase",
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#5a6776",
        "text-halo-color": "rgba(255,255,255,0.5)",
        "text-halo-width": 1,
      },
    });
    map.addLayer({
      id: "county-fill",
      type: "fill",
      source: "counties",
      paint: {
        "fill-color": [
          "match",
          ["feature-state", "cls"],
          0, RAMP[0],
          1, RAMP[1],
          2, RAMP[2],
          3, RAMP[3],
          4, RAMP[4],
          NA_COLOR,
        ],
        "fill-opacity": 0.65,
      },
    });
    map.addLayer({
      id: "county-line",
      type: "line",
      source: "counties",
      paint: { "line-color": "#000000", "line-width": 0.5 },
    });
    map.addLayer({
      id: "county-hover",
      type: "line",
      source: "counties",
      paint: {
        "line-color": "#000000",
        "line-width": 2,
        // bold outline when a county is hovered OR is the selected county
        "line-opacity": [
          "case",
          [
            "any",
            ["boolean", ["feature-state", "hover"], false],
            ["boolean", ["feature-state", "selected"], false],
          ],
          1,
          0,
        ],
      },
    });
    STATE_LABELS.forEach(({ coords, name }) => {
      const el = document.createElement("div");
      el.className = "state-label";
      el.textContent = name;
      new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat(coords)
        .addTo(map);
    });

    map.on("zoom", syncZoomButtons);
    wireMapInteraction();

    // Paint the choropleth as soon as the county source is parsed — this is
    // independent of the basemap raster tiles, so the fills appear immediately
    // on a hard refresh instead of waiting for everything to settle.
    markMapReadyWhenCountiesLoad();
  });
}

function markMapReadyWhenCountiesLoad() {
  const ready = () => {
    if (state.mapReady) return;
    state.mapReady = true;
    paintMap();
  };
  if (map.isSourceLoaded("counties")) {
    ready();
    return;
  }
  const onData = (e) => {
    if (e.sourceId === "counties" && map.isSourceLoaded("counties")) {
      map.off("sourcedata", onData);
      ready();
    }
  };
  map.on("sourcedata", onData);
}

/* keep zoom buttons in sync with the locked min zoom (MapLibre's own handler
 * uses strict equality and can re-enable zoom-out after a zoom event) */
function syncZoomButtons() {
  const zoomOut = document.querySelector(".maplibregl-ctrl-zoom-out");
  const zoomIn = document.querySelector(".maplibregl-ctrl-zoom-in");
  if (zoomOut) zoomOut.disabled = map.getZoom() <= map.getMinZoom() + 0.05;
  if (zoomIn) zoomIn.disabled = map.getZoom() >= map.getMaxZoom() - 0.05;
}

let hoveredId = null;

function wireMapInteraction() {
  map.on("mousemove", "county-fill", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const feat = e.features[0];
    const name = feat.properties.name;
    if (feat.id !== hoveredId) {
      if (hoveredId != null) map.setFeatureState({ source: "counties", id: hoveredId }, { hover: false });
      hoveredId = feat.id;
      map.setFeatureState({ source: "counties", id: hoveredId }, { hover: true });
    }
    // while drilled into a county the pinned popup is showing; keep the hover
    // outline for "click to switch" feedback but don't stack a hover popup
    if (state.selectedCounty) return;
    const county = state.byCounty.get(name);
    if (!county) {
      popup.remove();
      return;
    }
    const cases = countyYearValue(county, state.model, "cases");
    const inc = countyYearValue(county, state.model, "incidence");
    let html =
      `<div class="popup-title">${name} County</div>` +
      `<div class="popup-row"><b>${cases == null ? "—" : fmtNum2(cases)}</b> forecasted cases</div>` +
      `<div class="popup-row"><b>${inc == null ? "—" : inc.toFixed(1)}</b> per 100k</div>`;
    if (state.metric === "pctchange") {
      const pct = countyPctChange(county, state.model);
      const pctTxt =
        pct == null
          ? "—"
          : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%`;
      html += `<div class="popup-row"><b>${pctTxt}</b> vs. prior year</div>`;
    }
    popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
  map.on("mouseleave", "county-fill", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
    if (hoveredId != null) {
      map.setFeatureState({ source: "counties", id: hoveredId }, { hover: false });
      hoveredId = null;
    }
  });
  // click a county to drill into its single-county view
  map.on("click", "county-fill", (e) => {
    const name = e.features[0].properties.name;
    if (state.byCounty.has(name)) selectCounty(name);
  });
}

/* ---------- county drill-down ---------- */
// the raw county feature, used for geometry (bounds + centroid)
function countyFeature(name) {
  const id = state.nameToFeatureId.get(name);
  return id == null || !countiesGeo ? null : countiesGeo.features[id];
}

// run fn(ring) over every linear ring of a Polygon / MultiPolygon
function eachRing(geometry, fn) {
  const polys =
    geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  polys.forEach((poly) => poly.forEach((ring) => fn(ring)));
}

// full bounding box including offshore islands -> the zoom frame fits all parts
function countyBounds(name) {
  const feat = countyFeature(name);
  if (!feat) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  eachRing(feat.geometry, (ring) => {
    ring.forEach(([x, y]) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    });
  });
  return minX === Infinity ? null : [[minX, minY], [maxX, maxY]];
}

function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function ringCentroid(ring) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    x += (ring[j][0] + ring[i][0]) * f;
    y += (ring[j][1] + ring[i][1]) * f;
  }
  a *= 0.5;
  return a === 0 ? ring[0] : [x / (6 * a), y / (6 * a)];
}

// centroid of the largest polygon = a point on the county's mainland, so the
// pinned popup sits over the "continental" area even when islands stretch bounds
function countyAnchor(name) {
  const feat = countyFeature(name);
  if (!feat) return null;
  const g = feat.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  let best = null, bestArea = -1;
  polys.forEach((poly) => {
    const area = Math.abs(ringSignedArea(poly[0]));
    if (area > bestArea) {
      bestArea = area;
      best = poly[0];
    }
  });
  return best ? ringCentroid(best) : null;
}

function selectCounty(name) {
  if (!state.byCounty.has(name)) return;
  // clear the previous selection's outline before switching
  if (state.selectedCounty && state.selectedCounty !== name) {
    const prevId = state.nameToFeatureId.get(state.selectedCounty);
    if (prevId != null) map.setFeatureState({ source: "counties", id: prevId }, { selected: false });
  }
  state.selectedCounty = name;
  const id = state.nameToFeatureId.get(name);
  if (id != null) map.setFeatureState({ source: "counties", id }, { selected: true });

  popup.remove(); // drop any lingering hover popup
  const b = countyBounds(name);
  if (b) {
    // generous top padding pushes island-county mainlands (LA, Santa Barbara)
    // down below the legend; the lower maxZoom keeps small counties (Kings) from
    // filling the whole frame
    map.fitBounds(b, {
      padding: { top: 130, bottom: 70, left: 55, right: 55 },
      maxZoom: 8,
      duration: 700,
    });
  }
  const anchor = countyAnchor(name);
  if (anchor) {
    pinnedPopup
      .setLngLat(anchor)
      .setHTML(`<div class="popup-title popup-pinned-title">${name} County</div>`)
      .addTo(map);
  }
  el.mapLegend.classList.add("is-hidden");
  el.mapBack.classList.add("is-visible");
  render();
  maybeAdvanceTourAfterCounty();
}

function exitCounty() {
  if (!state.selectedCounty) return;
  const id = state.nameToFeatureId.get(state.selectedCounty);
  if (id != null) map.setFeatureState({ source: "counties", id }, { selected: false });
  state.selectedCounty = null;
  if (pinnedPopup) pinnedPopup.remove();
  el.mapLegend.classList.remove("is-hidden");
  el.mapBack.classList.remove("is-visible");
  map.fitBounds(CA_BOUNDS, { padding: CA_PADDING, duration: 700 });
  render();
}

function paintMap() {
  if (!state.mapReady) return;
  // swap the fill ramp to match the active metric (discrete vs. continuous)
  map.setPaintProperty("county-fill", "fill-color", fillColorExpr(state.metric));
  const isPct = state.metric === "pctchange";
  state.byCounty.forEach((county, name) => {
    const id = state.nameToFeatureId.get(name);
    if (id == null) return;
    const v = countyMapValue(county, state.model, state.metric);
    if (isPct) {
      // continuous gradient: feed the raw % into the interpolate expression
      map.setFeatureState(
        { source: "counties", id },
        v == null ? { hasVal: false } : { val: v, hasVal: true }
      );
    } else {
      map.setFeatureState(
        { source: "counties", id },
        { cls: classify(v, YEAR_BREAKS[state.metric]) }
      );
    }
  });
}

/* ---------- render ---------- */
function render() {
  paintMap();
  renderLegend();
  renderSummary();
  updateChart();
}

function renderLegend() {
  const metric = state.metric;
  // legend title always mirrors the selected metric's dropdown label, wrapping
  // the trailing phrase onto its own line for the longer titles
  if (metric === "pctchange") {
    el.legendTitle.innerHTML = "% Change from<br>Previous Year";
  } else if (metric === "incidence") {
    el.legendTitle.innerHTML = "1-Year Forecasted<br>Incidence per 100k";
  } else {
    el.legendTitle.textContent =
      el.metricSelect.selectedOptions[0]?.textContent || METRIC_LABEL[metric];
  }

  // diverging % change legend: a continuous blue (decline) -> white (no change)
  // -> red (increase) gradient bar, labeled at five anchors
  if (metric === "pctchange") {
    // top = +100% increase (deep red), bottom = −100% decline (deep blue)
    const labels = ["100%", "50%", "0%", "−50%", "−100%"];
    el.legendList.innerHTML =
      `<li class="legend-gradient">` +
      `<span class="gradient-bar" style="background:linear-gradient(to top, ${RAMP_DIV.join(", ")})"></span>` +
      `<span class="gradient-labels">${labels.map((l) => `<span>${l}</span>`).join("")}</span>` +
      `</li>`;
    return;
  }
  const b = YEAR_BREAKS[metric];
  const fmt = metric === "cases" ? (x) => fmtNum(x) : (x) => x;
  const labels = [
    `< ${fmt(b[0])}`,
    `${fmt(b[0])} – ${fmt(b[1])}`,
    `${fmt(b[1])} – ${fmt(b[2])}`,
    `${fmt(b[2])} – ${fmt(b[3])}`,
    `≥ ${fmt(b[3])}`,
  ];
  el.legendList.innerHTML = labels
    .map(
      (lab, i) =>
        `<li><span class="swatch" style="background:${RAMP[i]}"></span>${lab}</li>`
    )
    .join("");
}

function renderSummary() {
  if (state.selectedCounty) {
    renderCountySummary();
    return;
  }
  // statewide stats over the 1-year forecast window (matches the map metrics)
  const months = state.data.months;
  const len = months.length;
  const priorIdx = priorYearIndices();

  let totalCases = 0;
  let priorTotal = 0;
  let incSum = 0;
  let count = 0;
  state.byCounty.forEach((county) => {
    const yearCases = countyYearValue(county, state.model, "cases");
    if (yearCases == null) return;
    totalCases += yearCases;
    incSum += (yearCases / county.pop) * 1e5;
    count += 1;
    const prior = sumCounty(county, state.model, priorIdx);
    if (prior != null) priorTotal += prior;
  });
  const range = `${fmtMonth(chartAnchorYM)} - ${fmtMonth(months[len - 1])}`;

  el.summaryTitle.textContent = "STATEWIDE SUMMARY";
  el.casesSub.textContent = `${MODEL_LABEL[state.model]} — ${range}`;
  el.incidenceLabel.textContent = "Avg. incidence";
  el.casesStat.textContent = count ? fmtNum(totalCases) : "—";
  el.incidenceStat.textContent = count ? (incSum / count).toFixed(1) : "—";

  // statewide year-over-year % change in forecasted cases
  el.highRiskLabel.textContent = "% Change";
  el.highRiskSub.textContent = "vs. prior year";
  if (!count || priorTotal === 0) {
    el.highRiskStat.textContent = "—";
  } else {
    const pct = ((totalCases - priorTotal) / priorTotal) * 100;
    const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
    el.highRiskStat.textContent = `${sign}${Math.abs(pct).toFixed(1)}%`;
  }
}

// single-county stats: 1-year forecasted cases, 1-year forecasted incidence, and
// the change in forecasted cases vs. the prior year — all for the selected model.
function renderCountySummary() {
  const county = state.byCounty.get(state.selectedCounty);
  const months = state.data.months;
  const len = months.length;
  const priorIdx = [];
  for (let i = Math.max(0, len - 24); i < len - 12; i += 1) priorIdx.push(i);

  const yearCases = countyYearValue(county, state.model, "cases");
  const yearInc = countyYearValue(county, state.model, "incidence");
  const prior = sumCounty(county, state.model, priorIdx);
  const range = `${fmtMonth(chartAnchorYM)} - ${fmtMonth(months[len - 1])}`;

  el.summaryTitle.textContent = `${state.selectedCounty.toUpperCase()} COUNTY SUMMARY`;

  el.casesStat.textContent = yearCases == null ? "—" : fmtNum2(yearCases);
  el.casesSub.textContent = `${MODEL_LABEL[state.model]} — ${range}`;

  el.incidenceLabel.textContent = "Forecasted incidence";
  el.incidenceStat.textContent = yearInc == null ? "—" : yearInc.toFixed(1);

  el.highRiskLabel.textContent = "Change vs. prior year";
  if (yearCases == null || prior == null) {
    el.highRiskStat.textContent = "—";
    el.highRiskSub.textContent = "vs. prior forecast year";
  } else {
    const delta = Math.round((yearCases - prior) * 100) / 100; // two decimals
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
    el.highRiskStat.textContent = `${sign}${fmtNum2(Math.abs(delta))}`;
    el.highRiskSub.textContent = `${delta >= 0 ? "more" : "fewer"} forecasted cases`;
  }
}

/* ---------- chart ---------- */
// The trend chart is anchored on the most complete month in the data (the last
// month present): a user-selectable number of years of history (state.yearsBack)
// before the forecast plus the 1-year forecast horizon itself. The window — and
// the red forecast line — shift automatically as new data/model runs extend the
// series.
const CHART_YEARS_FWD = 1;

// always show this many x-axis labels, whatever the selected time span
const X_TICK_COUNT = 7;

// indices of the evenly-spaced x-axis labels for the current window. Always
// includes the first and last month, with a fixed count in between, so every
// range option shows the same number of ticks (robust to any window length).
function xTickIndices() {
  const n = chartWindow.length;
  const set = new Set();
  if (n <= 0) return set;
  const count = Math.min(X_TICK_COUNT, n);
  if (count === 1) {
    set.add(0);
    return set;
  }
  for (let i = 0; i < count; i += 1) {
    set.add(Math.round((i * (n - 1)) / (count - 1)));
  }
  return set;
}

let chartWindow = []; // YM strings spanning the visible window (oldest -> newest)
let xTickSet = new Set(); // indices of the x-axis labels for the current window
let chartAnchorYM = ""; // where the red forecast line sits (start of the forecast year)
let stateIncFactor = 0; // multiply statewide case counts by this for per-100k incidence

// case-count -> incidence-per-100k factor for whatever the chart is currently
// showing: the statewide total, or the selected county when drilled in. The
// plotted line stays in case counts; only the y-axis numbers + tooltip change.
function currentIncFactor() {
  if (state.selectedCounty) {
    const c = state.byCounty.get(state.selectedCounty);
    return c && c.pop > 0 ? 1e5 / c.pop : 0;
  }
  return stateIncFactor;
}
function toIncidence(cases) {
  return cases == null ? null : cases * currentIncFactor();
}

let statewideByModel = {}; // model -> array over all months of the statewide total

// Statewide monthly totals for every model. The ensemble already ships at the
// statewide level; the component models don't, so we sum their county
// predictions here to draw the selected model's forecast line.
function buildStatewideByModel() {
  const months = state.data.months;
  statewideByModel = {};
  (state.data.meta.models || []).forEach((model) => {
    if (model === "ensemble") {
      statewideByModel.ensemble = state.data.statewide.ensemble;
      return;
    }
    const sums = new Array(months.length).fill(null);
    state.byCounty.forEach((county) => {
      const series = county.cases[model];
      if (!series) return;
      for (let i = 0; i < months.length; i += 1) {
        const v = series[i];
        if (v != null) sums[i] = (sums[i] || 0) + v;
      }
    });
    statewideByModel[model] = sums;
  });
}

// the selected model's statewide forecast line, sliced to the visible window
function windowedForecast(model) {
  const idx = new Map(state.data.months.map((m, i) => [m, i]));
  const arr = statewideByModel[model] || [];
  return chartWindow.map((ym) => {
    const i = idx.get(ym);
    return i == null ? null : arr[i] ?? null;
  });
}

// 95% range band drawn around the selected model's line. There is a single
// statewide residual width (meta.residual_band_95, derived from the ensemble's
// observed-period residuals) — no per-model band ships — so we apply it as
// line ± band (lower clamped at 0). For the ensemble this reproduces the stored
// statewide.lower/upper exactly.
function windowedBand(model, which) {
  const band = state.data.meta.residual_band_95 || 0;
  return windowedForecast(model).map((v) => {
    if (v == null) return null;
    return which === "upper" ? v + band : Math.max(v - band, 0);
  });
}

// the selected county's forecast line for one model, sliced to the window
function windowedCountyForecast(county, model) {
  const series = county.cases[model] || [];
  const idx = new Map(state.data.months.map((m, i) => [m, i]));
  return chartWindow.map((ym) => {
    const i = idx.get(ym);
    return i == null ? null : series[i] ?? null;
  });
}

// 95% range for a county. Only one statewide residual width ships, so we scale
// it by the county's share of the statewide forecast each month — the band stays
// proportional to the line instead of swamping small counties with a flat ±width.
function windowedCountyBand(county, model, which) {
  const band = state.data.meta.residual_band_95 || 0;
  const stateArr = statewideByModel[model] || [];
  const series = county.cases[model] || [];
  const idx = new Map(state.data.months.map((m, i) => [m, i]));
  return chartWindow.map((ym) => {
    const i = idx.get(ym);
    if (i == null) return null;
    const v = series[i];
    if (v == null) return null;
    const stateV = stateArr[i];
    const w = stateV && stateV > 0 ? band * (v / stateV) : 0;
    return which === "upper" ? v + w : Math.max(v - w, 0);
  });
}

// year-over-year % change for the % change metric. Given a full-length monthly
// case series (observed and/or forecast), each window month becomes its change
// vs. the same month one year (12 months) earlier. Months without a prior-year
// value, or where the prior year is zero, are null.
function windowedYoY(fullSeries) {
  const idx = new Map(state.data.months.map((m, i) => [m, i]));
  return chartWindow.map((ym) => {
    const i = idx.get(ym);
    if (i == null || i < 12) return null;
    const cur = fullSeries[i];
    const prev = fullSeries[i - 12];
    if (cur == null || prev == null || prev === 0) return null;
    return ((cur - prev) / prev) * 100;
  });
}

// statewide monthly cases over ALL months: observed where it exists, otherwise
// the selected model's forecast (so the forecast year and the year-over-year
// lookback both have values)
function combinedStatewideCases(model) {
  const sw = state.data.statewide;
  const fc = statewideByModel[model] || [];
  return state.data.months.map((m, i) => {
    const o = sw.observed ? sw.observed[i] : null;
    return o != null ? o : fc[i] ?? null;
  });
}

// clean axis bounds + step for the % change line: always spans 0, pads the data,
// then snaps min/max to whole multiples of a round step so every tick is an even
// number (e.g. -50, 0, 50, 100) regardless of the data range
function pctAxisBounds(vals) {
  const present = vals.filter((v) => v != null);
  let lo = present.length ? Math.min(0, ...present) : -10;
  let hi = present.length ? Math.max(0, ...present) : 10;
  const pad = Math.max((hi - lo) * 0.1, 5);
  lo -= pad;
  hi += pad;
  // pick the smallest round step that keeps the axis to ~6 intervals or fewer
  const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const span = hi - lo;
  let step = STEPS[STEPS.length - 1];
  for (const s of STEPS) {
    if (span / s <= 6) {
      step = s;
      break;
    }
  }
  return {
    min: Math.floor(lo / step) * step,
    max: Math.ceil(hi / step) * step,
    step,
  };
}

// round a value up to a clean axis maximum (~12% headroom), at any magnitude —
// keeps the county chart well-fitted whether the county peaks at 3 or 3,000
function niceMax(v) {
  if (!v || v <= 0) return 10;
  const target = v * 1.12;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const half = mag / 2;
  const stepped = Math.ceil(target / half) * half;
  return parseFloat(stepped.toPrecision(12)); // e.g. 0.35000000000000003 -> 0.35
}

function setYAxis(max, step) {
  chart.options.scales.y.max = max;
  chart.options.scales.y.ticks.stepSize = step; // undefined => Chart.js auto-ticks
}

function ymAdd(ym, months) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function buildChartWindow() {
  const months = state.data.months;
  const lastMonth = months[months.length - 1]; // most complete month in the data
  chartAnchorYM = ymAdd(lastMonth, -CHART_YEARS_FWD * 12); // forecast begins a year back
  const start = ymAdd(lastMonth, -(state.yearsBack + CHART_YEARS_FWD) * 12);
  const list = [];
  let ym = start;
  while (true) {
    list.push(ym);
    if (ym === lastMonth) break;
    ym = ymAdd(ym, 1);
  }
  chartWindow = list;
  xTickSet = xTickIndices(); // recompute the fixed-count label positions
}

// light gray dashed horizontal line at y = 0% — only for the % change view,
// marking the no-change baseline
const zeroLinePlugin = {
  id: "zeroLine",
  beforeDatasetsDraw(c) {
    if (state.metric !== "pctchange") return;
    const y = c.scales.y.getPixelForValue(0);
    if (y == null) return;
    const { left, right } = c.chartArea;
    const ctx = c.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(120, 130, 140, 0.45)";
    ctx.stroke();
    ctx.restore();
  },
};

// thin red vertical line marking where the forecast begins (the current month)
const forecastLinePlugin = {
  id: "forecastLine",
  afterDatasetsDraw(c) {
    const idx = chartWindow.indexOf(chartAnchorYM);
    if (idx < 0) return;
    const x = c.scales.x.getPixelForValue(idx);
    const { top, bottom } = c.chartArea;
    const ctx = c.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#c8102e";
    ctx.stroke();
    ctx.restore();
  },
};

function initChart() {
  buildChartWindow();
  buildStatewideByModel();
  let totalPop = 0;
  state.byCounty.forEach((c) => (totalPop += c.pop || 0));
  stateIncFactor = totalPop > 0 ? 1e5 / totalPop : 0;
  const sw = state.data.statewide;
  const midx = new Map(state.data.months.map((m, i) => [m, i]));
  const seriesFor = (key) =>
    chartWindow.map((ym) => {
      const i = midx.get(ym);
      return i == null ? null : sw[key][i];
    });
  // y-axis tops out at the highest visible value + 200 headroom, rounded up to
  // the nearest hundred for a clean axis maximum
  const visibleVals = ["upper", "ensemble", "observed"]
    .flatMap(seriesFor)
    .filter((v) => v != null);
  const dataMax = visibleVals.length ? Math.max(...visibleVals) : 0;
  const yMax = Math.ceil((dataMax + 200) / 100) * 100;
  const ctx = document.getElementById("trendChart").getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartWindow.slice(),
      datasets: [
        {
          label: "upper",
          data: windowedBand(state.model, "upper"),
          borderWidth: 0,
          pointRadius: 0,
          fill: "+1",
          backgroundColor: "rgba(53,127,184,0.16)",
        },
        {
          label: "lower",
          data: windowedBand(state.model, "lower"),
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
        },
        {
          label: "Ensemble Forecast",
          data: windowedForecast(state.model),
          borderColor: "#c8102e",
          borderWidth: 1.2,
          borderDash: [4, 3],
          pointRadius: 0,
          tension: 0.25,
        },
        {
          label: "Observed",
          data: seriesFor("observed"),
          borderColor: "#1b2733",
          borderWidth: 1.2,
          pointRadius: 0,
          spanGaps: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // render the canvas backing store at >=3x CSS pixels so the line stays
      // crisp instead of upscaling a low-res bitmap on standard-density displays
      devicePixelRatio: Math.max(window.devicePixelRatio || 1, 3),
      layout: { padding: { top: 4, right: 4 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          // datasets 2 (forecast) and 3 (observed); the forecast label is dynamic
          filter: (item) => item.datasetIndex === 2 || item.datasetIndex === 3,
          callbacks: {
            title: (items) => (items.length ? fmtMonth(chartWindow[items[0].dataIndex]) : ""),
            // solid swatch in the line's own color (red forecast, black observed)
            labelColor: (c) => ({
              borderColor: c.dataset.borderColor,
              backgroundColor: c.dataset.borderColor,
              borderWidth: 0,
            }),
            label: (c) => {
              if (c.parsed.y == null) return `${c.dataset.label}: —`;
              if (state.metric === "pctchange") {
                const v = c.parsed.y;
                const sign = v > 0 ? "+" : v < 0 ? "−" : "";
                return `${c.dataset.label}: ${sign}${Math.abs(v).toFixed(1)}%`;
              }
              if (state.metric === "incidence")
                return `${c.dataset.label}: ${toIncidence(c.parsed.y).toFixed(1)} per 100k`;
              // county monthly forecasts are fractional, so keep a decimal when
              // drilled into a county; statewide totals stay whole numbers
              const cases = state.selectedCounty
                ? fmtNum2(c.parsed.y)
                : `${Math.round(c.parsed.y)}`;
              return `${c.dataset.label}: ${cases} cases`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          // bottom baseline drawn from x=0 to x=max
          border: { display: true, color: "#1b2733" },
          // fixed number of evenly-spaced, angled labels regardless of span
          ticks: {
            autoSkip: false,
            maxRotation: 45,
            minRotation: 45,
            font: { size: 9 },
            callback: (value, index) =>
              xTickSet.has(index) ? fmtMonth(chartWindow[index]) : "",
          },
        },
        y: {
          beginAtZero: true,
          max: yMax,
          // vertical axis line at x=0, no horizontal gridlines behind the plot
          grid: { display: false },
          border: { display: true, color: "#1b2733" },
          // even ticks up to the rounded max; positions stay fixed (case scale)
          // but labels switch to per-100k incidence when that metric is selected
          ticks: {
            stepSize: yMax / 4,
            font: { size: 9 },
            callback: (value) => {
              if (state.metric === "pctchange") return `${value}%`;
              if (state.metric === "incidence")
                return `${+toIncidence(value).toFixed(1)}`;
              return fmtAxisCases(value);
            },
          },
        },
      },
    },
    plugins: [zeroLinePlugin, forecastLinePlugin],
  });
}

// refresh the chart for the selected model + metric. The plotted series stay in
// case counts, so the metric switch only relabels the y-axis numbers + tooltip.
function updateChart() {
  if (!chart) return;
  if (state.selectedCounty) updateChartCounty();
  else updateChartStatewide();
  chart.update("none");
}

// rebuild the visible window after the history range changes, then refresh labels
// and data (the forecast year is always retained)
function rebuildChartRange() {
  if (!chart) return;
  buildChartWindow();
  chart.data.labels = chartWindow.slice();
  updateChart();
}

// statewide view: black observed line + the selected model's red dashed forecast
// and its 95% band.
function updateChartStatewide() {
  if (state.metric === "pctchange") return updateChartStatewidePct();
  const forecastLabel = `${MODEL_LABEL[state.model]} Forecast`;
  const sw = state.data.statewide;
  const midx = new Map(state.data.months.map((m, i) => [m, i]));
  const observed = chartWindow.map((ym) => {
    const i = midx.get(ym);
    return i == null ? null : sw.observed[i];
  });

  // restore the 95% band (hidden in the % change view) and a zero-based axis
  chart.data.datasets[0].hidden = false;
  chart.data.datasets[1].hidden = false;
  el.legBand.style.display = "";
  chart.options.scales.y.beginAtZero = true;
  chart.options.scales.y.min = 0;

  chart.data.datasets[0].data = windowedBand(state.model, "upper");
  chart.data.datasets[1].data = windowedBand(state.model, "lower");
  const fc = chart.data.datasets[2];
  fc.data = windowedForecast(state.model);
  fc.label = forecastLabel;
  fc.hidden = false;
  const obs = chart.data.datasets[3];
  obs.data = observed;
  obs.label = "Observed";

  const vals = [...chart.data.datasets[0].data, ...fc.data, ...observed].filter((v) => v != null);
  const dataMax = vals.length ? Math.max(...vals) : 0;
  const yMax = Math.ceil((dataMax + 200) / 100) * 100;
  setYAxis(yMax, yMax / 4);

  // legend: black key = "Observed", show the red dashed forecast key
  el.legObsLabel.textContent = "Observed";
  el.legPred.style.display = "";
  el.legendForecastLabel.textContent = forecastLabel;
  el.chartTitle.textContent =
    state.metric === "incidence"
      ? "Observed vs. Forecasted Incidence"
      : "Observed vs. Forecasted Cases";
}

// county view: no observed actuals exist for a county, so the black line carries
// the county's forecast; the red dashed line is hidden and the 95% band tracks it.
function updateChartCounty() {
  if (state.metric === "pctchange") return updateChartCountyPct();
  const county = state.byCounty.get(state.selectedCounty);
  const modelLabel = `${MODEL_LABEL[state.model]} Forecast`;
  const line = windowedCountyForecast(county, state.model);

  // restore the 95% band (hidden in the % change view) and a zero-based axis
  chart.data.datasets[0].hidden = false;
  chart.data.datasets[1].hidden = false;
  el.legBand.style.display = "";
  chart.options.scales.y.beginAtZero = true;
  chart.options.scales.y.min = 0;

  chart.data.datasets[0].data = windowedCountyBand(county, state.model, "upper");
  chart.data.datasets[1].data = windowedCountyBand(county, state.model, "lower");
  chart.data.datasets[2].hidden = true; // hide the red dashed forecast line
  const obs = chart.data.datasets[3];
  obs.data = line;
  obs.label = modelLabel;

  const vals = [...chart.data.datasets[0].data, ...line].filter((v) => v != null);
  const dataMax = vals.length ? Math.max(...vals) : 0;
  setYAxis(niceMax(dataMax), undefined);

  // legend: black key now means the forecast; hide the red dashed forecast key
  el.legObsLabel.textContent = modelLabel;
  el.legPred.style.display = "none";
  el.chartTitle.textContent =
    state.metric === "incidence" ? "Forecasted Incidence" : "Forecasted Cases";
}

// shared setup for the % change line: hide the band datasets + legend, switch the
// y-axis off zero-based so declines render below the baseline
function configurePctChart() {
  chart.data.datasets[0].hidden = true;
  chart.data.datasets[1].hidden = true;
  chart.data.datasets[0].data = [];
  chart.data.datasets[1].data = [];
  el.legBand.style.display = "none";
  chart.options.scales.y.beginAtZero = false;
}

// statewide % change: one continuous black year-over-year change line across
// history and the forecast year. No red dashed forecast line, no forecast
// divider, and no 95% band — a ratio metric has no residual width here.
function updateChartStatewidePct() {
  const yoy = windowedYoY(combinedStatewideCases(state.model));
  configurePctChart();

  chart.data.datasets[2].hidden = true; // hide the red dashed forecast line
  const obs = chart.data.datasets[3];
  obs.data = yoy;
  obs.label = "% Change";

  const { min, max, step } = pctAxisBounds(yoy);
  chart.options.scales.y.min = min;
  setYAxis(max, step);

  el.legObsLabel.textContent = "% Change";
  el.legPred.style.display = "none";
  el.chartTitle.textContent = "Year-over-Year % Change";
}

// county % change: a single line of the county forecast's year-over-year change
function updateChartCountyPct() {
  const county = state.byCounty.get(state.selectedCounty);
  const modelLabel = `${MODEL_LABEL[state.model]} Forecast`;
  const yoy = windowedYoY(county.cases[state.model] || []);
  configurePctChart();

  chart.data.datasets[2].hidden = true;
  const obs = chart.data.datasets[3];
  obs.data = yoy;
  obs.label = modelLabel;

  const { min, max, step } = pctAxisBounds(yoy);
  chart.options.scales.y.min = min;
  setYAxis(max, step);

  el.legObsLabel.textContent = modelLabel;
  el.legPred.style.display = "none";
  el.chartTitle.textContent = "Year-over-Year % Change";
}

/* ---------- formatting ---------- */
function fmtMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
function fmtFullDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d || 1).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
function fmtNum(x) {
  return Math.round(x).toLocaleString("en-US");
}
// county predictions are fractional expected counts (e.g. Siskiyou ~1.69/yr,
// Mono with two-decimal precision), so county-level case figures keep two
// decimals instead of rounding to whole cases
function fmtNum2(x) {
  return Number(x).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
// strip binary float dust from an axis value, e.g. 0.35000000000000003 -> 0.35
function fmtAxisCases(value) {
  return `${parseFloat(value.toPrecision(12))}`;
}

/* ---------- onboarding tour ----------
 * A lightweight, dependency-free guided tour. Each step dims the page (a single
 * box-shadowed "spotlight" over the target) and shows a step card. The spotlight
 * has pointer-events:none, so highlighted features stay fully clickable — the map
 * step even auto-advances when the user actually drills into a county. */
const TOUR_STEPS = [
  {
    welcome: true, // intro bubble — shown without a step number
    title: "Welcome to <em>CocciCast</em>!",
    body: "This is a quick 5-step tutorial of how to read and explore the forecast. Use Next, or click the highlighted controls yourself.",
    placement: "center",
  },
  {
    target: "#metricSelect",
    title: "Choose what the map shows",
    body: "Color counties by forecasted cases, incidence per 100k, or year-over-year % change.",
    placement: "right",
  },
  {
    target: "#modelSelect",
    title: "Switch the model",
    body: "View the ensemble forecast or any single component model behind it.",
    placement: "right",
  },
  {
    target: "#map",
    title: "Explore the map",
    body: "Hover a county for a quick readout — or click one now to drill into its own forecast.",
    placement: "right",
  },
  {
    target: "#rangeSelect",
    title: "Set the time range",
    body: "Choose how many previous years the chart shows. The 1-year forecast is always included.",
    placement: "left",
  },
  {
    target: "#specsLink",
    title: "Dig deeper",
    body: "Open the About panel to read how the forecast was built and the science behind it.",
    placement: "right",
  },
];

let tourIndex = 0;
const tourEls = {};

function tourInit() {
  tourEls.root = document.getElementById("tour");
  tourEls.spot = document.getElementById("tourSpotlight");
  tourEls.card = document.getElementById("tourCard");
  tourEls.step = document.getElementById("tourStep");
  tourEls.title = document.getElementById("tourTitle");
  tourEls.body = document.getElementById("tourBody");
  tourEls.back = document.getElementById("tourBack");
  tourEls.next = document.getElementById("tourNext");
  tourEls.skip = document.getElementById("tourSkip");

  tourEls.back.addEventListener("click", () => gotoTourStep(tourIndex - 1));
  tourEls.next.addEventListener("click", () => {
    if (tourIndex >= TOUR_STEPS.length - 1) endTour();
    else gotoTourStep(tourIndex + 1);
  });
  tourEls.skip.addEventListener("click", endTour);
  document.getElementById("tourBtn").addEventListener("click", () => {
    if (specsOpen) {
      closeSpecs();
      setTimeout(startTour, REVEAL_MS + EXPAND_MS + FLIP_MS + 50);
    } else {
      startTour();
    }
  });

  // keep the spotlight glued to its target as the page scrolls or resizes.
  // reposition without the slide transition so it tracks the element instantly.
  // `capture: true` also catches scrolling inside nested scroll containers.
  const trackTour = () => {
    if (!tourEls.root.hidden) positionTour(false);
  };
  window.addEventListener("scroll", trackTour, { passive: true, capture: true });
  window.addEventListener("resize", trackTour);
  document.addEventListener("keydown", (e) => {
    if (tourEls.root.hidden) return;
    if (e.key === "Escape") endTour();
    else if (e.key === "ArrowRight") tourEls.next.click();
    else if (e.key === "ArrowLeft" && tourIndex > 0) gotoTourStep(tourIndex - 1);
  });
}

// show the tour once per browser session: sessionStorage survives in-tab
// reloads (normal or hard refresh) but resets when the tab/window is closed and
// reopened, so a fresh session re-triggers the tour
function maybeStartTour() {
  let seen = false;
  try {
    seen = sessionStorage.getItem("cocciTourSeen") === "1";
  } catch (e) {
    /* private mode / storage disabled — just show it */
  }
  if (seen) return; // already shown this session
  // mark seen immediately so any later load this session (even a mid-tour
  // reload) won't re-trigger it — it's then reachable only via the button
  try {
    sessionStorage.setItem("cocciTourSeen", "1");
  } catch (e) {
    /* ignore */
  }
  // dim the screen right away (spotlight only, card hidden) so there's no bright
  // flash before the welcome bubble eases in after the map + chart settle
  tourEls.root.hidden = false;
  tourEls.card.style.visibility = "hidden";
  positionTour(false);
  setTimeout(startTour, 500);
}

function startTour() {
  tourEls.root.hidden = false;
  tourEls.card.style.visibility = "";
  gotoTourStep(0);
}

function endTour() {
  tourEls.root.hidden = true;
  try {
    sessionStorage.setItem("cocciTourSeen", "1");
  } catch (e) {
    /* ignore */
  }
}

function gotoTourStep(i) {
  tourIndex = Math.max(0, Math.min(i, TOUR_STEPS.length - 1));
  const s = TOUR_STEPS[tourIndex];
  // the welcome bubble carries no step number; the rest count 1..N
  const numberedTotal = TOUR_STEPS.filter((x) => !x.welcome).length;
  if (s.welcome) {
    tourEls.step.style.display = "none";
    tourEls.step.textContent = "";
    // retrigger the entrance animation each time the welcome bubble appears
    tourEls.card.classList.remove("is-welcome");
    void tourEls.card.offsetWidth; // force reflow so the animation restarts
    tourEls.card.classList.add("is-welcome");
  } else {
    tourEls.card.classList.remove("is-welcome");
    const stepNo = TOUR_STEPS.slice(0, tourIndex + 1).filter((x) => !x.welcome).length;
    tourEls.step.style.display = "";
    tourEls.step.textContent = `Step ${stepNo} of ${numberedTotal}`;
  }
  tourEls.title.innerHTML = s.title;
  tourEls.body.textContent = s.body;
  tourEls.back.disabled = tourIndex === 0;
  tourEls.next.textContent = tourIndex === TOUR_STEPS.length - 1 ? "Done" : "Next";
  positionTour(true);
}

// when the user clicks a county during the map step, advance automatically
function maybeAdvanceTourAfterCounty() {
  maybeAdvanceTourOnTarget("#map");
}

function maybeAdvanceTourOnTarget(target) {
  if (
    tourEls.root &&
    !tourEls.root.hidden &&
    TOUR_STEPS[tourIndex] &&
    TOUR_STEPS[tourIndex].target === target
  ) {
    if (tourIndex >= TOUR_STEPS.length - 1) endTour();
    else gotoTourStep(tourIndex + 1);
  }
}

function positionTour(animate = true) {
  const s = TOUR_STEPS[tourIndex];
  const target = s.target ? document.querySelector(s.target) : null;
  const { spot, card } = tourEls;
  // slide between steps, but track scroll/resize instantly (no transition lag)
  spot.style.transition = animate ? "" : "none";
  const pad = 8;
  if (target) {
    const r = target.getBoundingClientRect();
    spot.style.top = `${r.top - pad}px`;
    spot.style.left = `${r.left - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
    placeTourCard(r, s.placement || "bottom");
  } else {
    // center step: collapse the hole at screen center (full dim) and center card
    spot.style.top = "50%";
    spot.style.left = "50%";
    spot.style.width = "0px";
    spot.style.height = "0px";
    card.style.top = `${Math.max(12, (window.innerHeight - card.offsetHeight) / 2)}px`;
    card.style.left = `${(window.innerWidth - card.offsetWidth) / 2}px`;
  }
}

// place the step card beside the target, preferring the requested side but
// flipping to whichever side has room, then clamping inside the viewport
function placeTourCard(r, placement) {
  const card = tourEls.card;
  const gap = 14;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = null;
  let left = null;
  for (const p of [placement, "bottom", "top", "right", "left"]) {
    if (p === "bottom" && r.bottom + gap + ch <= vh) {
      top = r.bottom + gap;
      left = r.left;
      break;
    }
    if (p === "top" && r.top - gap - ch >= 0) {
      top = r.top - gap - ch;
      left = r.left;
      break;
    }
    if (p === "right" && r.right + gap + cw <= vw) {
      left = r.right + gap;
      top = r.top;
      break;
    }
    if (p === "left" && r.left - gap - cw >= 0) {
      left = r.left - gap - cw;
      top = r.top;
      break;
    }
  }
  if (top === null) {
    top = r.bottom + gap;
    left = r.left;
  }
  left = Math.max(12, Math.min(left, vw - cw - 12));
  top = Math.max(12, Math.min(top, vh - ch - 12));
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}
