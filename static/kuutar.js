// kuutar: a three.js wrapper for 3D benchmark graphs.
// v0: X=time, Y=metric value (normalized per series), Z=(test_name, metric) slot
// ordered by variance ascending (low-variance series in front).
// Shape by metric kind (see shapes.js). Color by timestamp (newest = shiny, oldest = dark).
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { geometryFor, unitToKind } from "./shapes.js";
import { OrbitController } from "./camera.js";
import { Narrator } from "./narrator.js";
import { AudioEngine } from "./audio.js";

const AXIS_LEN = 2.0;

// Time-based colormap: saturated blue across almost the entire primary
// window, a narrow whitening zone at the x=0 boundary (picked up by
// `whitenAmount` below), and past-side grayscale fading to near-black.
// t=0 is at the x=0 boundary; t=1 is at now().
const TIME_STOPS = [
  [0.00, [0x4a, 0x82, 0xb8]],  // medium blue (→ near-white after boundary whitening)
  [0.10, [0x4a, 0x90, 0xd0]],  // saturated medium blue — no more whitening
  [0.30, [0x48, 0xa4, 0xe8]],  // strong blue
  [0.60, [0x64, 0xc0, 0xf8]],  // brighter blue
  [1.00, [0x8c, 0xd4, 0xff]],  // peak blue at now
];

function _srgb(r, g, b) {
  const c = new THREE.Color();
  c.setRGB(r, g, b, THREE.SRGBColorSpace);
  return c;
}

function timeColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < TIME_STOPS.length - 1; i++) {
    const [t0, c0] = TIME_STOPS[i];
    const [t1, c1] = TIME_STOPS[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return _srgb(
        (c0[0] + (c1[0] - c0[0]) * f) / 255,
        (c0[1] + (c1[1] - c0[1]) * f) / 255,
        (c0[2] + (c1[2] - c0[2]) * f) / 255,
      );
    }
  }
  const [, last] = TIME_STOPS[TIME_STOPS.length - 1];
  return _srgb(last[0] / 255, last[1] / 255, last[2] / 255);
}

// Points older than the primary window fade from gray to black as they recede
// into the past. `t` = 0 at the edge of the primary window, 1 at the oldest
// point in the dataset.
// Whitening is now tightly scoped to the x=0 boundary — 0.85 at t=0,
// smoothly dropping to 0 by t=0.10. Everything from ~10% of the primary
// onward retains full blue saturation. The boundary band blends into
// `pastColor` on the other side of x=0 without a seam.
function whitenAmount(t) {
  const x = Math.max(0, Math.min(1, (0.10 - t) / 0.10));
  const smooth = x * x * (3 - 2 * x);
  return 0.85 * smooth;
}

function pastColor(t) {
  t = Math.max(0, Math.min(1, t));
  // Boundary color: exactly what primary renders at its t=0 end (timeColor(0)
  // lifted by the full whitenAmount). Keeps x=0 crossing seamless.
  const boundary = timeColor(0);
  boundary.lerp(_srgb(1, 1, 1), whitenAmount(0));
  // Deep near-background color at the oldest end (stays above #0b0d12 bg).
  const deep = _srgb(0x18 / 255, 0x18 / 255, 0x1e / 255);
  const eased = Math.pow(t, 1.2);
  boundary.lerp(deep, eased);
  return boundary;
}

// Categorical palette for per-series line colors. Red / green / orange
// are deliberately absent — those hues are reserved for change-point
// markers (regression = red, improvement = green).
export const SERIES_PALETTE = [
  0x4e79a7,  // blue
  0xc94f9e,  // magenta
  0x6a4c93,  // indigo
  0x76b7b2,  // teal
  0x1b9aaa,  // cyan
  0xedc949,  // yellow
  0xaf7aa1,  // purple
  0xf2b5d1,  // pale rose pink
  0x9c755f,  // brown
  0xbab0ab,  // gray
  0x6baed6,  // light blue
  0xb49ed8,  // lavender
];

export function seriesHexColor(zi) {
  return SERIES_PALETTE[zi % SERIES_PALETTE.length];
}

// Three coloring tiers so the field reads as a starry sky, not a circus.
// Tier A (even): original time colormap (blue → white → gray).
// Tier B (1,5,9,…): grayscale version of the same gradient — no chroma.
// Tier C (3,7,11,…): categorical palette, same color everywhere.
function seriesTier(zi) {
  if (zi % 2 === 0) return "A";
  return (zi % 4 === 1) ? "B" : "C";
}

const TIER_A_LINE_HEX = 0x78c8ff;  // blue, matches the new-end of the colormap
const TIER_B_LINE_HEX = 0xb8b8bc;  // neutral light gray

function tierLineHex(zi) {
  const t = seriesTier(zi);
  if (t === "A") return TIER_A_LINE_HEX;
  if (t === "B") return TIER_B_LINE_HEX;
  return seriesHexColor(zi);
}

// Dedicated grayscale ramp for tier B. Not derived from TIME_STOPS'
// luminance (which dips mid-curve where the colormap shifts from pale
// gray to saturated blue), and brighter overall so peaks near now()
// read as near-white rather than medium gray.
const GRAY_STOPS = [
  [0.00, 0x38],
  [0.15, 0x74],
  [0.32, 0xac],
  [0.55, 0xcc],
  [0.75, 0xe4],
  [0.90, 0xf0],
  [1.00, 0xf6],
];

function timeGrayColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < GRAY_STOPS.length - 1; i++) {
    const [t0, g0] = GRAY_STOPS[i];
    const [t1, g1] = GRAY_STOPS[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      const g = (g0 + (g1 - g0) * f) / 255;
      return _srgb(g, g, g);
    }
  }
  const last = GRAY_STOPS[GRAY_STOPS.length - 1][1] / 255;
  return _srgb(last, last, last);
}

function variance(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let s = 0;
  for (const x of xs) s += (x - mean) ** 2;
  return s / xs.length;
}

// Candidate per-run attribute keys that carve series identity when the
// dataset actually varies along them. Facets in the UI use the same set.
const SPLIT_ATTRS = ["runner", "workflow", "branch"];

function _attrOrField(run, key) {
  if (key === "branch") return run.branch;
  return (run.attributes || {})[key];
}

function seriesKey(run, metric, splitBy = []) {
  const base = `${run.attributes?.test_name || "?"}|${metric.name}`;
  if (splitBy.length === 0) return base;
  const extras = splitBy.map(k => _attrOrField(run, k) || "").join("|");
  return `${base}|${extras}`;
}

function seriesLabel(test_name, metric_name, splitVals) {
  let s = `${test_name} · ${metric_name}`;
  if (splitVals && splitVals.length) s += " · " + splitVals.join(" · ");
  return s;
}

function inferDirection(kind) {
  // Default: lower_is_better (durations, sizes, ratios all want smaller).
  // Throughput is the notable inversion.
  return kind === "throughput" ? "higher_is_better" : "lower_is_better";
}

// Detect the single most prominent step change in a series using a rolling
// before/after mean delta. Returns {i, score, before, after} or null.
// `i` is the index of the *first* sample in the "after" window.
function detectChangePoint(values, W = 7, threshold = 0.15) {
  if (values.length < W * 2 + 1) return null;
  let best = { i: -1, score: 0, before: 0, after: 0 };
  for (let i = W; i < values.length - W; i++) {
    let before = 0, after = 0;
    for (let j = 0; j < W; j++) { before += values[i - 1 - j]; after += values[i + j]; }
    before /= W; after /= W;
    const baseline = Math.max(Math.abs(before), Math.abs(after), 1e-9);
    const score = Math.abs(before - after) / baseline;
    if (score > best.score) best = { i, score, before, after };
  }
  return best.score >= threshold ? best : null;
}

export class Kuutar {
  constructor(container, opts = {}) {
    this.container = container;
    this.narrator = opts.narrator || new Narrator();
    this.audio = opts.audio || new AudioEngine();
    // Primary time window = the span of data mapped to positive X [0, axisX].
    // Anything older renders into negative X, fading to black. Default: 90 days.
    this.primaryDays = opts.primaryDays || 90;

    this.scene = new THREE.Scene();
    this.scene.background = _srgb(0x0b / 255, 0x0d / 255, 0x12 / 255);

    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);

    // Stretch the time axis to match viewport aspect. Y is shorter than Z so
    // that at the horizontal-fit distance there's breathing room above and
    // below the data band.
    const aspect = Math.max(1, w / h);
    this.axisX = AXIS_LEN * aspect;
    this.axisY = AXIS_LEN * 0.7;
    this.axisZ = AXIS_LEN * 1.1;

    // Frame the primary window by its actual X extent (not the bounding sphere,
    // which over-zooms and leaves dead space on wide screens since the box is
    // already aspect-scaled).
    const target = new THREE.Vector3(this.axisX / 2, this.axisY / 2, this.axisZ / 2);
    const fillFraction = 0.70;
    const fovRad = (this.camera.fov * Math.PI) / 180;
    // Horizontal half-width needed at target depth: (axisX / 2) / fillFraction.
    // Horizontal frustum half-width at distance d = d * tan(fov/2) * aspect.
    const distance = (this.axisX / 2 / fillFraction) / (Math.tan(fovRad / 2) * aspect);
    const az = (30 * Math.PI) / 180;
    const el = (20 * Math.PI) / 180;
    this.camera.position.set(
      target.x + distance * Math.cos(el) * Math.sin(az),
      target.y + distance * Math.sin(el),
      target.z + distance * Math.cos(el) * Math.cos(az),
    );
    this.camera.lookAt(target);
    // Canonical camera offset (from target) captured at scene setup.
    // Per-stop easing re-derives the camera pose as `endTarget +
    // initialOffset × zoomFactor` so successive stops don't accumulate
    // drift, and "zoom in" / "zoom out" stay relative to a fixed baseline.
    this._initialCamOffset = this.camera.position.clone().sub(target);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // Default sRGB output; colors are created via setRGB(..., SRGBColorSpace)
    // so hex values we pick render at their intended perceptual brightness.
    container.appendChild(this.renderer.domElement);

    this.camController = new OrbitController(this.camera, this.renderer.domElement, target);

    // Low ambient + multiple directional sources from different angles so
    // specular highlights shift across points as the camera orbits.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const k1 = new THREE.DirectionalLight(0xffffff, 1.2);
    k1.position.set(3, 5, 4);
    this.scene.add(k1);
    const k2 = new THREE.DirectionalLight(0xa8c8ff, 0.6);  // cool fill from the other side
    k2.position.set(-4, 2, -3);
    this.scene.add(k2);

    this._addAxes();

    this.pointsGroup = new THREE.Group();
    this.scene.add(this.pointsGroup);

    // Vertical "time cursor" plane perpendicular to X. Snaps to the X of
    // the nearest-hovered marker to highlight a specific moment and the
    // column of points (one per series) that share it.
    const cursorGeo = new THREE.PlaneGeometry(this.axisZ * 1.6, this.axisY * 1.6);
    cursorGeo.rotateY(Math.PI / 2);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.018,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._cursorPlane = new THREE.Mesh(cursorGeo, cursorMat);
    this._cursorPlane.position.set(0, this.axisY / 2, this.axisZ / 2);
    this._cursorPlane.visible = false;
    this.scene.add(this._cursorPlane);
    // Second plane that stays in place when a commit is locked.
    const lockedMat = cursorMat.clone();
    lockedMat.opacity = 0.025;
    this._lockedPlane = new THREE.Mesh(cursorGeo, lockedMat);
    this._lockedPlane.position.copy(this._cursorPlane.position);
    this._lockedPlane.visible = false;
    this.scene.add(this._lockedPlane);
    this._columnMeshes = null;
    this._lockedColumn = null;
    this._locked = null;   // { mesh, zi, idx, x }
    this._byIdx = new Map();

    // Flyover tour state. Populated by `startFlyover`; controlled via
    // play/pause/step methods. Emits `flyover_state` events so the HTML
    // controls can render.
    this._flyState = "idle";    // idle | countdown | playing | paused | done
    this._flyList = [];         // sorted CP list
    this._flyIdx = 0;
    this._flyTimer = null;
    this._flyCountdown = 0;
    this._flyEaseRAF = null;

    // Hover/picking state.
    this._seriesLines = [];   // zi -> Line (populated each render)
    this._cpBeforeLines = []; // zi -> Line2 for the pre-change-point segment (optional)
    this._hoveredZi = -1;
    this._lineBaseOpacity = 0.10;
    this._lineBaseWidth = 1;  // pixels
    this._raycaster = new THREE.Raycaster();
    this._mouseNdc = new THREE.Vector2();
    // Any user interaction on the canvas aborts a running countdown —
    // the user can press play to restart the tour manually. Hover, click,
    // scroll / zoom, and rotate / pan all count as interaction.
    const cancelCountdown = () => {
      if (this._flyState === "countdown") this.pauseFlyover();
    };
    this.renderer.domElement.addEventListener("pointermove", (e) => { cancelCountdown(); this._onPointerMove(e); });
    this.renderer.domElement.addEventListener("pointerleave", () => this._clearHover());
    this.renderer.domElement.addEventListener("wheel", cancelCountdown, { passive: true });
    // Drag detection: if pointerup is within a few pixels of pointerdown,
    // treat as a click; otherwise it was a rotate/pan and we exit any lock.
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      cancelCountdown();
      this._pressStart = { x: e.clientX, y: e.clientY, button: e.button };
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      const s = this._pressStart;
      this._pressStart = null;
      if (!s) return;
      // A drag (moved > a few pixels) is a rotate/pan — don't treat it as
      // a click. Camera movement never affects lock state.
      const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y);
      if (moved > 4) return;
      if (s.button === 0) this._onPointerClick();
    });

    // Resize handling.
    window.addEventListener("resize", () => this._onResize());
    this._animate = this._animate.bind(this);
    requestAnimationFrame(this._animate);

    // Stub hooks the post-v0 UI will call.
    this.goToChangePoint = (_id) => {};
    this.setTimeRange = (_from, _to) => {};
    this.selectMetric = (_name) => {};
  }

  _addAxes() {
    // Positive X: gradient matching the time colormap (oldest-in-primary
    // near origin, newest at +axisX). Mirrors the point coloring.
    const SEGMENTS = 48;
    const xPos = [], xCol = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const t0 = i / SEGMENTS;
      const t1 = (i + 1) / SEGMENTS;
      const c0 = timeColor(t0);
      const c1 = timeColor(t1);
      xPos.push(t0 * this.axisX, 0, 0, t1 * this.axisX, 0, 0);
      xCol.push(c0.r, c0.g, c0.b, c1.r, c1.g, c1.b);
    }
    const xGeo = new THREE.BufferGeometry();
    xGeo.setAttribute("position", new THREE.Float32BufferAttribute(xPos, 3));
    xGeo.setAttribute("color", new THREE.Float32BufferAttribute(xCol, 3));
    this.scene.add(new THREE.LineSegments(xGeo, new THREE.LineBasicMaterial({ vertexColors: true })));


    // Y and Z: plain dark gray for now.
    const dim = new THREE.LineBasicMaterial({ color: 0x3a3a3a });
    const yGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, this.axisY, 0),
    ]);
    const zGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, this.axisZ),
    ]);
    this.scene.add(new THREE.Line(yGeo, dim));
    this.scene.add(new THREE.Line(zGeo, dim));

    // Axis labels (as sprites).
    const labels = [
      { text: "time →", pos: [this.axisX + 0.35, 0, this.axisZ * 0.3] },
      { text: "value →", pos: [0, this.axisY + 0.1, 0] },
      { text: "tests →", pos: [0, 0, this.axisZ * 0.9] },
    ];
    for (const { text, pos } of labels) {
      const sprite = this._makeLabel(text);
      sprite.position.set(...pos);
      this.scene.add(sprite);
    }
  }

  _makeLabel(text) {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.font = "28px sans-serif";
    ctx.fillStyle = "#cdd";
    ctx.fillText(text, 4, 40);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.6, 0.15, 1);
    return sprite;
  }

  render(runs) {
    // Clear previous.
    while (this.pointsGroup.children.length) {
      const c = this.pointsGroup.children.pop();
      c.geometry?.dispose();
      c.material?.dispose();
    }
    this._seriesLines = [];
    this._cpBeforeLines = [];
    this._seriesInfo = [];
    this._changePoints = [];
    this._hoveredZi = -1;
    this._hoveredMesh = null;
    this._columnMeshes = null;
    this._lockedColumn = null;
    this._locked = null;
    this._byIdx = new Map();
    if (this._cursorPlane) this._cursorPlane.visible = false;
    if (this._lockedPlane) this._lockedPlane.visible = false;
    // Cancel any running flyover from a previous dataset.
    if (this._flyTimer) { clearTimeout(this._flyTimer); clearInterval(this._flyTimer); this._flyTimer = null; }
    if (this._flyEaseRAF) { cancelAnimationFrame(this._flyEaseRAF); this._flyEaseRAF = null; }
    this._flyList = [];
    this._flyIdx = 0;
    this._flyState = "idle";
    if (!runs || runs.length === 0) return;

    // Auto-detect which candidate attrs *vary* across the fetched runs;
    // those become part of series identity so e.g. the same test on Intel
    // and ARM render as two distinct series. Attrs with a single distinct
    // value collapse out (one main branch → no split).
    const splitBy = [];
    for (const key of SPLIT_ATTRS) {
      const distinct = new Set();
      for (const run of runs) {
        const v = _attrOrField(run, key);
        if (v) distinct.add(v);
        if (distinct.size > 1) break;
      }
      if (distinct.size > 1) splitBy.push(key);
    }

    // Gather series (test_name, metric_name, ...splitBy) -> info.
    const series = new Map();
    for (const run of runs) {
      for (const m of run.metrics || []) {
        const k = seriesKey(run, m, splitBy);
        if (!series.has(k)) {
          series.set(k, {
            test_name: run.attributes?.test_name || "?",
            metric: m.name,
            unit: m.unit,
            direction: m.direction || inferDirection(unitToKind(m.unit, m.name)),
            splitVals: splitBy.map(sk => _attrOrField(run, sk) || ""),
            values: [],
            times: [],
            commits: [],
          });
        }
        const entry = series.get(k);
        entry.values.push(m.value);
        // Prefer commit (merge) time — a single commit can have many reruns,
        // but the perf characteristic belongs to the code change. Fall back
        // to run timestamp only if the v2 commit sub-document is missing.
        const commit = run.commit || { sha: run.git_commit, short_sha: (run.git_commit || "").slice(0, 7) };
        const ts = (typeof commit.commit_time === "number")
          ? commit.commit_time * 1000
          : new Date(_tsOf(run)).getTime();
        entry.times.push(ts);
        entry.commits.push(commit);
      }
    }

    // Global time bounds.
    let tMin = Infinity, tMax = -Infinity;
    for (const s of series.values()) {
      for (const t of s.times) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    }

    // Primary window occupies positive X [0, axisX]; its right edge is the newest data.
    const DAY_MS = 86400 * 1000;
    const primarySpan = this.primaryDays * DAY_MS;
    const primaryEnd = tMax;
    const primaryStart = primaryEnd - primarySpan;
    // Anything older than primaryStart fades into negative X.
    const pastSpan = Math.max(1, primaryStart - tMin);

    // Per-series mean for Y scaling + variance for ordering.
    // Y is scaled relative to the mean: flat-with-noise looks flat; a 20%
    // excursion reaches ~20% of the half-axis. Min/max stretch was misleading
    // (it turned pure noise into visual trends).
    const Y_GAIN = this.axisY;  // ±100% deviation fills ±half of Y axis
    for (const s of series.values()) {
      const mean = s.values.reduce((a, b) => a + b, 0) / s.values.length;
      s.mean = mean;
      const denom = Math.max(1e-9, Math.abs(mean));
      s.variance = variance(s.values.map(v => v / denom));
    }

    // Order series so low-variance sits in back (small Z), high-variance in front.
    const keys = [...series.keys()].sort(
      (a, b) => series.get(b).variance - series.get(a).variance,
    );
    const zStep = keys.length > 1 ? this.axisZ / (keys.length - 1) : this.axisZ;

    // Marker size adapts to density: it keys off the TIGHTER of the Z-spacing
    // (series neighbors) and the X-spacing (time neighbors), so sparse data
    // gets bigger markers and dense data shrinks. The multiplier 0.1875 gives
    // ~50% gap between touching neighbors, further reduced by 25%.
    const maxPointsPerSeries = Math.max(
      1, ...[...series.values()].map(s => s.values.length),
    );
    const xStep = this.axisX / Math.max(1, maxPointsPerSeries - 1);
    const tight = Math.min(zStep, xStep);
    const markerSize = Math.max(0.0045, Math.min(0.045, tight * 0.28));

    // Regression/improvement colors for change-point markers.
    const CP_REGRESSION = _srgb(1.00, 0.32, 0.32);   // light red
    const CP_IMPROVEMENT = _srgb(0.42, 0.88, 0.48);  // light green

    const DARK_BG = _srgb(0x18 / 255, 0x18 / 255, 0x1e / 255);

    keys.forEach((k, zi) => {
      const s = series.get(k);
      const kind = unitToKind(s.unit, s.metric);
      const geo = geometryFor(kind, markerSize);
      const series_name = seriesLabel(s.test_name, s.metric, s.splitVals);
      const tier = seriesTier(zi);
      const lineHex = tierLineHex(zi);
      const tierColor = _srgb(((lineHex >> 16) & 0xff) / 255, ((lineHex >> 8) & 0xff) / 255, (lineHex & 0xff) / 255);
      this._seriesInfo[zi] = {
        key: k, zi, name: series_name, color: lineHex,
      };

      // Detect the series' most prominent step change up front so each
      // marker knows whether it is THE change point and whether that
      // change is a regression or an improvement.
      // Window adapts to series length: 7 for dense (daily) data, down
      // to 2 for sparse data (weekly / release cadence).
      const _W = Math.max(2, Math.min(7, Math.floor((s.values.length - 1) / 2)));
      const cp = detectChangePoint(s.values, _W);
      let cpIdx = -1, cpDeltaPct = 0, cpIsRegression = false, cpEntry = null;
      if (cp) {
        cpIdx = cp.i;
        cpDeltaPct = (cp.after - cp.before) / Math.max(Math.abs(cp.before), 1e-9);
        // Direction inversion: for lower_is_better, an increase is bad;
        // for higher_is_better, a decrease is bad.
        cpIsRegression = (s.direction === "higher_is_better") ? (cpDeltaPct < 0) : (cpDeltaPct > 0);
        cpEntry = { zi, idx: cpIdx, deltaPct: cpDeltaPct, regression: cpIsRegression, mesh: null };
        this._changePoints.push(cpEntry);
      }

      const linePos = [];
      for (let i = 0; i < s.values.length; i++) {
        const ts = s.times[i];
        // Marker color by tier. A/B use a time-based gradient (color/gray);
        // C holds the palette color steady. All tiers fade toward dark in
        // the past so depth/age still reads.
        let x, color, emissiveFactor;
        if (ts >= primaryStart) {
          const t = (ts - primaryStart) / primarySpan;
          x = t * this.axisX;
          if (tier === "C") {
            color = tierColor.clone();
          } else {
            color = tier === "A" ? timeColor(t) : timeGrayColor(t);
            color.lerp(_srgb(1, 1, 1), whitenAmount(t));
          }
          emissiveFactor = Math.pow(t, 2.2);
        } else {
          const backT = (primaryStart - ts) / pastSpan;
          x = -backT * (pastSpan / primarySpan) * this.axisX;
          if (tier === "C") {
            color = tierColor.clone().lerp(DARK_BG, Math.pow(backT, 1.2));
          } else {
            color = pastColor(backT);  // grayscale already, fine for A and B
          }
          emissiveFactor = 0;
        }
        const denom = Math.max(1e-9, Math.abs(s.mean));
        const y = this.axisY / 2 + ((s.values[i] - s.mean) / denom) * (Y_GAIN / 2);
        const z = zi * zStep;

        // Change-point markers override the time-based color with a strong
        // red/green and get a permanent 2x scale (applied via mesh.scale, not
        // geometry, so hover scaling can compose cleanly). The marker
        // immediately before the CP also scales up (visual symmetry with
        // the thicker before-segment) but keeps its own color.
        const isCp = i === cpIdx;
        const isPreCp = cpIdx > 0 && i === cpIdx - 1;
        const markerColor = isCp ? (cpIsRegression ? CP_REGRESSION : CP_IMPROVEMENT) : color;
        // "Starlight" treatment for every primary, non-CP marker
        // regardless of tier: a self-glow floor across the whole primary
        // span (not just the newest quarter), higher opacity, and
        // sharper specular. Keeps small default points and large
        // on-plane points consistent — only size differs.
        const isStar = !isCp && ts >= primaryStart;
        const mat = new THREE.MeshStandardMaterial({
          color: markerColor,
          metalness: isCp ? 0.5 : 0.9,
          roughness: isCp ? 0.35 : (isStar ? 0.22 : 0.28),
          emissive: markerColor,
          emissiveIntensity: isCp ? 0.7
                           : isStar ? (0.20 + emissiveFactor * 0.80)
                           : emissiveFactor * 0.75,
          opacity: isCp ? 0.95 : (isStar ? 0.90 : 0.75),
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        const baseScale = (isCp || isPreCp) ? 2 : 1;
        mesh.scale.setScalar(baseScale);
        mesh.userData = {
          isPoint: true,
          series: k, zi, idx: i,
          series_name, test_name: s.test_name, metric: s.metric,
          unit: s.unit, direction: s.direction,
          value: s.values[i], timestamp: s.times[i],
          commit: s.commits[i],
          baseScale,
          _baseOpacity: mat.opacity,
          isChangePoint: isCp,
          ...(isCp ? {
            cpBefore: cp.before, cpAfter: cp.after,
            cpDeltaPct, regression: cpIsRegression,
          } : {}),
        };
        this.pointsGroup.add(mesh);
        if (isCp && cpEntry) cpEntry.mesh = mesh;
        // Column index: meshes with the same `i` share a time/commit; used
        // by the time-cursor highlight to snap them all to full opacity.
        if (!this._byIdx.has(i)) this._byIdx.set(i, []);
        this._byIdx.get(i).push(mesh);
        linePos.push(x, y, z);
      }

      if (linePos.length >= 6) {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        // Split the line at the change-point index, if any. The "before"
        // segment is rendered thicker and in the CP color (red for a
        // regression, green for an improvement) so the direction of the
        // step reads at a glance. Both segments share the CP vertex so
        // there's no visible gap.
        const hasSplit = cpIdx > 0 && cpIdx < s.values.length - 1;

        const mainGeo = new LineGeometry();
        mainGeo.setPositions(linePos);
        const mainMat = new LineMaterial({
          color: tierColor,
          linewidth: this._lineBaseWidth,
          transparent: true,
          opacity: this._lineBaseOpacity,
          depthWrite: false,
        });
        mainMat.resolution.set(w, h);
        const mainLine = new Line2(mainGeo, mainMat);
        mainLine.userData = {
          baseOpacity: this._lineBaseOpacity,
          baseWidth: this._lineBaseWidth,
        };
        this.pointsGroup.add(mainLine);
        this._seriesLines[zi] = mainLine;

        if (hasSplit) {
          // Just the single segment from the point immediately before the
          // CP to the CP itself — a visual arrow into the step, not a long
          // trail from the start of history.
          const beforePos = linePos.slice((cpIdx - 1) * 3, (cpIdx + 1) * 3);
          const cpCol = cpIsRegression ? CP_REGRESSION : CP_IMPROVEMENT;
          const beforeMat = new LineMaterial({
            color: cpCol,
            linewidth: 2,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
          });
          beforeMat.resolution.set(w, h);
          const beforeGeo = new LineGeometry();
          beforeGeo.setPositions(beforePos);
          const beforeLine = new Line2(beforeGeo, beforeMat);
          beforeLine.userData = { baseOpacity: 0.45, baseWidth: 2 };
          this.pointsGroup.add(beforeLine);
          this._cpBeforeLines[zi] = beforeLine;
        }
      }
    });

    this.narrator.emit({
      type: "render_complete",
      series_count: keys.length,
      point_count: this.pointsGroup.children.length,
      series: this.getSeries(),
      change_points: this._changePoints.length,
    });
  }

  getSeries() {
    return this._seriesInfo.slice();
  }

  hoverSeries(zi) {
    const v = (zi == null || zi < 0) ? -1 : zi;
    if (v === this._hoveredZi) return;
    this._hoveredZi = v;
    this._applyHoverState();
  }

  _onPointerMove(e) {
    if (this._seriesLines.length === 0) return;
    // Don't re-pick hover while a rotate/pan drag is in progress.
    if (this._pressStart) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Screen-space nearest-marker pick: project each point to NDC and keep
    // the closest one within a generous pixel threshold. Much more forgiving
    // than raycaster hits on small meshes — the cursor doesn't need to be
    // exactly on top of a point to highlight its series.
    const THRESHOLD_PX = 40;
    const thSq = THRESHOLD_PX * THRESHOLD_PX;
    const halfW = rect.width / 2, halfH = rect.height / 2;
    const v = this._tmpV || (this._tmpV = new THREE.Vector3());
    let nearest = null, nearestDSq = thSq;
    for (const m of this.pointsGroup.children) {
      if (!m.userData.isPoint) continue;
      v.copy(m.position).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const dx = (v.x - mx) * halfW;
      const dy = (v.y - my) * halfH;
      const dSq = dx * dx + dy * dy;
      if (dSq < nearestDSq) { nearestDSq = dSq; nearest = m; }
    }
    // In locked mode, ignore any point that's not on the locked cross
    // (same series zi, or same time idx). Off-cross hovers keep the lock
    // state visible and don't update anything.
    if (this._locked && nearest) {
      const ud = nearest.userData;
      if (ud.zi !== this._locked.zi && ud.idx !== this._locked.idx) {
        nearest = null;
      }
    }
    const zi = nearest ? nearest.userData.zi : -1;
    this._setHoveredMesh(nearest);
    this.hoverSeries(zi);
  }

  _setHoveredMesh(mesh) {
    if (mesh === this._hoveredMesh) return;
    const prev = this._hoveredMesh;
    this._hoveredMesh = mesh;
    this._updateTimeCursor(mesh);
    if (prev && prev !== mesh) this._applyMeshState(prev);
    if (mesh) this._applyMeshState(mesh);
    // Info-box rule: normally follow hover; in locked mode follow hover
    // while on a highlighted series (on-cross), and fall back to the
    // locked point when off-cross (mesh === null).
    if (this._locked) {
      const source = mesh || this._locked.mesh;
      this.narrator.emit({ type: "point_hovered", point: source.userData });
    } else if (mesh) {
      this.narrator.emit({ type: "point_hovered", point: mesh.userData });
    }
  }

  _updateTimeCursor(mesh) {
    const newCol = mesh ? (this._byIdx.get(mesh.userData.idx) || []) : [];
    const oldCol = this._columnMeshes || [];
    const newSet = new Set(newCol);
    this._columnMeshes = newCol;
    // Re-apply state on old members that left the hover column.
    for (const m of oldCol) if (!newSet.has(m)) this._applyMeshState(m);
    if (mesh) {
      this._cursorPlane.position.x = mesh.position.x;
      this._cursorPlane.visible = true;
    } else {
      this._cursorPlane.visible = false;
    }
    for (const m of newCol) this._applyMeshState(m);
  }

  // Central authority for each point mesh's visual state. Considers lock
  // column, hover column, and hovered-mesh emphasis; picks the strongest.
  _applyMeshState(m) {
    const inLocked = this._lockedColumn ? this._lockedColumn.includes(m) : false;
    const inHover  = this._columnMeshes ? this._columnMeshes.includes(m) : false;
    const isHot    = m === this._hoveredMesh;
    const base = m.userData.baseScale || 1;
    let scale = base;
    let opacity = m.userData._baseOpacity;
    if (inLocked || inHover) {
      opacity = 1.0;
      // Change points on the time-cursor plane pop larger than their
      // neighbors — 6× vs the 4× of normal column points.
      scale = m.userData.isChangePoint ? 6 : Math.max(scale, 4);
    }
    if (isHot) {
      // Hover always adds emphasis. In a column, add a bonus on top of
      // the column scale — larger for change points so they pop clearly
      // when hovered on the plane. Off-column, the original base × 1.6.
      if (inLocked || inHover) {
        scale += m.userData.isChangePoint ? 3 : 1;
      } else {
        scale = Math.max(scale, base * 1.6);
      }
    }
    m.material.opacity = opacity;
    m.scale.setScalar(scale);
  }

  _onPointerClick() {
    // Any user click pauses an in-progress flyover so they can explore.
    if (this._flyState === "playing" || this._flyState === "countdown") {
      this.pauseFlyover();
    }
    const mesh = this._hoveredMesh;
    if (!this._locked) {
      if (mesh) this._enterLock(mesh);
      return;
    }
    // In locked mode: clicking a cross point replaces the lock; clicking
    // off-cross (no hover, or hover off the cross) exits the lock.
    if (mesh && (mesh.userData.zi === this._locked.zi || mesh.userData.idx === this._locked.idx)) {
      this._enterLock(mesh);
    } else {
      this._exitLock();
    }
  }

  _enterLock(mesh, opts = {}) {
    const wasLocked = !!this._locked;
    // Tear down any existing lock's column state without a re-apply pass
    // (the new lock will cover it).
    if (wasLocked) {
      const old = this._lockedColumn || [];
      this._lockedColumn = null;
      this._locked = null;
      for (const m of old) this._applyMeshState(m);
    }
    // `zis` carries every series that should read as locked-HOT. Normally
    // just the clicked series; for flyover stops with multiple CPs on
    // the same commit it's all the sibling CP series so their timeline
    // lines light up together.
    const zis = opts.siblings && opts.siblings.length > 0
      ? opts.siblings.map(s => s.zi)
      : [mesh.userData.zi];
    this._locked = { mesh, zi: mesh.userData.zi, zis, idx: mesh.userData.idx, x: mesh.position.x };
    this._lockedPlane.position.x = mesh.position.x;
    this._lockedPlane.visible = true;
    this._lockedColumn = this._byIdx.get(mesh.userData.idx) || [];
    for (const m of this._lockedColumn) this._applyMeshState(m);
    // Locked series must read as HOT regardless of current hover.
    this._applyHoverState();
    // Pin the info box to the clicked point (or all CPs on this commit
    // for a flyover stop).
    this.narrator.emit({
      type: "point_hovered",
      point: mesh.userData,
      siblings: opts.siblings || null,
    });
  }

  _exitLock() {
    if (!this._locked) return;
    this._lockedPlane.visible = false;
    const old = this._lockedColumn || [];
    this._locked = null;
    this._lockedColumn = null;
    for (const m of old) this._applyMeshState(m);
    this._applyHoverState();
  }

  // ---------- Flyover tour ----------

  startFlyover() {
    this._cancelFlyoverTimers();
    if (!this._changePoints || this._changePoints.length === 0) return;
    // Group change points by their commit (idx). Each stop is one commit
    // that has at least one CP; within a stop, list CPs largest-first.
    // Stops are ordered newest commit first so the tour walks backward
    // in time — matching how a human would read "what changed recently".
    const byIdx = new Map();
    for (const cp of this._changePoints) {
      if (!cp.mesh) continue;
      if (!byIdx.has(cp.idx)) byIdx.set(cp.idx, []);
      byIdx.get(cp.idx).push(cp);
    }
    for (const list of byIdx.values()) {
      list.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
    }
    // Build stops across every commit (newest first). Commits within the
    // server's `recent_cp_days` window become stops regardless of whether
    // they carry CPs ("recent activity is always worth a glance"); older
    // commits only stop when they actually have CPs.
    const recentDays = (this.config && this.config.recent_cp_days) || 14;
    const recentMs = recentDays * 86400 * 1000;
    const allIdx = [...this._byIdx.keys()].sort((a, b) => b - a);
    const newestTs = allIdx.length > 0
      ? Math.max(...allIdx.map(i => (this._byIdx.get(i)[0]?.userData.timestamp) || 0))
      : 0;
    const threshold = newestTs - recentMs;
    const stops = [];
    for (const idx of allIdx) {
      const col = this._byIdx.get(idx) || [];
      const ts = col[0]?.userData.timestamp || 0;
      const cps = byIdx.get(idx) || [];
      const isRecent = ts >= threshold;
      if (cps.length > 0 || isRecent) {
        stops.push({ idx, cps });
      }
    }
    this._flyList = stops;
    this._flyIdx = 0;
    this._flyState = "countdown";
    this._flyCountdown = 10;
    this._emitFlyover();
    this._flyTimer = setInterval(() => {
      this._flyCountdown--;
      if (this._flyCountdown <= 0) {
        clearInterval(this._flyTimer);
        this._flyTimer = null;
        this._flyState = "playing";
        this._playFlyStep();
      } else {
        this._emitFlyover();
      }
    }, 1000);
  }

  pauseFlyover() {
    if (this._flyState === "idle" || this._flyState === "done") return;
    this._cancelFlyoverTimers();
    this._flyState = "paused";
    this._emitFlyover();
  }

  resumeFlyover() {
    if (this._flyState !== "paused") {
      // Allow play button to act as "start" when idle/done.
      if (this._flyState === "idle" || this._flyState === "done") this.startFlyover();
      return;
    }
    this._flyState = "playing";
    this._playFlyStep();
  }

  toggleFlyover() {
    if (this._flyState === "playing" || this._flyState === "countdown") {
      this.pauseFlyover();
    } else {
      this.resumeFlyover();
    }
  }

  stepFlyover(dir) {
    if (this._flyList.length === 0) return;
    this._cancelFlyoverTimers();
    // A manual step during countdown pauses the tour.
    if (this._flyState === "countdown") this._flyState = "paused";
    // Step jumps to the next/previous CP stop, skipping plain (non-CP)
    // scan stops. If none exists in that direction, stay put.
    let next = this._flyIdx;
    while (true) {
      next += dir;
      if (next < 0 || next >= this._flyList.length) return;
      if (this._flyList[next].cps.length > 0) break;
    }
    this._flyIdx = next;
    this._goToCp(this._flyIdx);
    if (this._flyState === "playing") {
      this._flyTimer = setTimeout(() => this._advanceFly(), 4000);
    }
    this._emitFlyover();
  }

  _playFlyStep() {
    if (this._flyIdx >= this._flyList.length) {
      this._flyState = "done";
      this._emitFlyover();
      return;
    }
    this._goToCp(this._flyIdx);
    this._emitFlyover();
    this._flyTimer = setTimeout(() => this._advanceFly(), 4000);
  }

  _advanceFly() {
    this._flyTimer = null;
    if (this._flyState !== "playing") return;
    this._flyIdx++;
    this._playFlyStep();
  }

  _cancelFlyoverTimers() {
    if (this._flyTimer) {
      clearTimeout(this._flyTimer);
      clearInterval(this._flyTimer);
      this._flyTimer = null;
    }
  }

  _goToCp(idx) {
    const stop = this._flyList[idx];
    if (!stop) return;
    const isFirst = idx === 0;
    const col = this._byIdx.get(stop.idx) || [];

    if (stop.cps.length === 0) {
      // Plain scan stop: plane moves, no lock. First stop also pulls the
      // camera back to a slight zoom-out overview; later plain stops keep
      // the camera wherever it was.
      this._exitLock();
      const anchor = col[0];
      if (!anchor) return;
      this._setHoveredMesh(anchor);
      if (isFirst) this._easeCameraTarget(anchor.position, { zoomFactor: 1.2 });
      return;
    }

    // CP stop — zoom in onto the CP cluster (except the very first stop,
    // which stays at the overview zoom-out level).
    this._setHoveredMesh(null);
    const largest = stop.cps[0];
    if (!largest.mesh) return;
    this._enterLock(largest.mesh, { siblings: stop.cps });
    const centroid = new THREE.Vector3();
    for (const cp of stop.cps) centroid.add(cp.mesh.position);
    centroid.multiplyScalar(1 / stop.cps.length);
    this._easeCameraTarget(centroid, { zoomFactor: isFirst ? 1.2 : 0.75 });
  }

  _easeCameraTarget(pos, { zoomFactor = 1.0 } = {}) {
    if (this._flyEaseRAF) cancelAnimationFrame(this._flyEaseRAF);
    const controls = this.camController.controls;
    const startTarget = controls.target.clone();
    const endTarget = pos.clone();
    const startCam = this.camera.position.clone();
    // End pose = canonical offset scaled by zoom, rooted at endTarget.
    const endCam = endTarget.clone()
      .add(this._initialCamOffset.clone().multiplyScalar(zoomFactor));
    const duration = 900;
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / duration);
      const e = k * k * (3 - 2 * k);  // smoothstep
      controls.target.lerpVectors(startTarget, endTarget, e);
      this.camera.position.lerpVectors(startCam, endCam, e);
      controls.update();
      if (k < 1) this._flyEaseRAF = requestAnimationFrame(tick);
      else this._flyEaseRAF = null;
    };
    tick();
  }

  _emitFlyover() {
    this.narrator.emit({
      type: "flyover_state",
      state: this._flyState,
      idx: this._flyIdx,
      total: this._flyList.length,
      countdown: this._flyCountdown,
    });
  }

  _clearHover() {
    this._setHoveredMesh(null);
    this.hoverSeries(-1);
  }

  _applyHoverState(neighborsFaded = false) {
    const HOT = 0.95, WARM = 0.65, DIM_OP = 0.08;
    const HOT_W = 3.5, WARM_W = 2;
    const lockedZis = this._locked ? new Set(this._locked.zis) : null;
    // In locked mode: no WARM neighbors at all — only the locked line(s)
    // and (if distinct) the currently-hovered line read as HOT. Everything
    // else is DIM, immediately.
    if (this._locked) neighborsFaded = true;
    const setTargets = (line, i) => {
      if (!line) return;
      const baseOp = line.userData.baseOpacity ?? this._lineBaseOpacity;
      const baseW  = line.userData.baseWidth   ?? this._lineBaseWidth;
      let op, w;
      const isLocked = lockedZis ? lockedZis.has(i) : false;
      if (this._hoveredZi === -1) {
        if (isLocked) { op = Math.max(baseOp, HOT); w = Math.max(baseW, HOT_W); }
        else          { op = baseOp; w = baseW; }
      } else {
        const d = Math.abs(i - this._hoveredZi);
        if (d === 0 || isLocked)             { op = Math.max(baseOp, HOT);  w = Math.max(baseW, HOT_W); }
        else if (d === 1 && !neighborsFaded) { op = Math.max(baseOp, WARM); w = Math.max(baseW, WARM_W); }
        else                                 { op = Math.min(baseOp, DIM_OP); w = baseW; }
      }
      line.userData._targetOpacity = op;
      line.userData._targetWidth = w;
    };
    for (let i = 0; i < this._seriesLines.length; i++) {
      setTargets(this._seriesLines[i], i);
      setTargets(this._cpBeforeLines[i], i);
    }
    if (!neighborsFaded) this.narrator.emit({ type: "hover_changed", zi: this._hoveredZi });

    // After a few seconds of stable hover, fade the two neighbors down to
    // DIM so only the hovered series remains highlighted. Any fresh hover
    // change clears the pending fade and re-shows the neighbors at WARM.
    if (this._neighborsFadeTimer) {
      clearTimeout(this._neighborsFadeTimer);
      this._neighborsFadeTimer = null;
    }
    if (this._hoveredZi !== -1 && !neighborsFaded) {
      this._neighborsFadeTimer = setTimeout(() => {
        this._neighborsFadeTimer = null;
        if (this._hoveredZi !== -1) this._applyHoverState(true);
      }, 200);
    }
  }

  _animate() {
    // Hover ease: snap *up* to the highlight instantly, but glide *down*
    // over ~2.5s so de-hovered series don't flash off like lightning.
    // Linear fade so the tail drops to target instead of lingering
    // asymptotically. In locked mode, snap — decisive feel.
    const snap = !!this._locked;
    const OP_STEP = 0.045;
    const W_STEP  = 0.18;
    const easeLine = (line) => {
      if (!line || line.userData._targetOpacity == null) return;
      const mat = line.material;
      const curOp = mat.opacity;
      const tgtOp = line.userData._targetOpacity;
      if (tgtOp >= curOp || snap) mat.opacity = tgtOp;
      else mat.opacity = Math.max(tgtOp, curOp - OP_STEP);
      const curW = mat.linewidth;
      const tgtW = line.userData._targetWidth;
      if (tgtW != null) {
        if (tgtW >= curW || snap) mat.linewidth = tgtW;
        else mat.linewidth = Math.max(tgtW, curW - W_STEP);
      }
    };
    for (const line of this._seriesLines) easeLine(line);
    for (const line of this._cpBeforeLines) easeLine(line);
    this.camController.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._animate);
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    for (const line of this._seriesLines) {
      if (line) line.material.resolution.set(w, h);
    }
    for (const line of this._cpBeforeLines) {
      if (line) line.material.resolution.set(w, h);
    }
  }

  async fetchAndRender(url) {
    // Pull server config first so `startFlyover` can honour the
    // `recent_cp_days` window. A missing endpoint just leaves defaults
    // in place — non-fatal.
    try {
      const cr = await fetch("/api/v3/config");
      if (cr.ok) this.config = await cr.json();
    } catch (e) { /* ignore */ }
    this.config = this.config || { recent_cp_days: 14 };

    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const runs = await res.json();
    this.render(runs);
    return runs;
  }
}

function _tsOf(run) {
  const ts = run.timestamp;
  if (typeof ts === "string") return ts;
  if (ts && typeof ts === "object" && "$date" in ts) return ts.$date;
  return ts;
}
