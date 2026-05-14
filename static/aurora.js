// Aurora Borealis: a three.js wrapper for 3D benchmark graphs.
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

// Known scalar dimensions live at specific nested paths in the
// canonical benchzoo shape. Everything else is a free-form benchmark
// parameter under ``test.params.*``.
const _SCALAR_PATHS = {
  branch:    (run) => (run.commit || {}).ref,
  runner:    (run) => (run.run || {}).runner,
  workflow:  (run) => (run.run || {}).workflow,
  test_name: (run) => (run.test || {}).test_name,
};

function _attrOrField(run, key) {
  if (key in _SCALAR_PATHS) return _SCALAR_PATHS[key](run);
  return ((run.test || {}).params || {})[key];
}

function seriesKey(run, metric, splitBy = []) {
  const base = `${(run.test || {}).test_name || "?"}|${metric.name}`;
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

export class Aurora {
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
    this.axisY = AXIS_LEN * 0.45;
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
    this._addStarfield();

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
    // Public-facing index space for callers outside aurora.js: a
    // commit's wall-clock timestamp (ms) maps to its local _byIdx
    // key. The internal `idx` shifts whenever the rendered window
    // changes, so external code (the SHA-strip hover, the commit
    // panel) must NOT use it directly — it'd dereference into a
    // stale mesh column. ``hoverCommitByTs`` does the translation.
    this._idxByTs = new Map();

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
    this._hoveredGroup = null;
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
      if (s.button === 0) {
        // On touch devices no pointermove fires before tap, so the
        // hover state is stale (null). Run the hover pick once with
        // the release coordinates so `_onPointerClick` sees the
        // mesh the user actually tapped.
        if (e.pointerType === "touch") this._onPointerMove(e);
        this._onPointerClick();
      }
    });

    // Resize handling.
    window.addEventListener("resize", () => this._onResize());
    this._animate = this._animate.bind(this);
    this._rafId = null;
    // Re-render whenever OrbitControls moves the camera (includes damping frames).
    this.camController.controls.addEventListener('change', () => this._requestRender());
    this._requestRender();

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

  // Very light sprinkle of stars/galaxies in the far background. Sits on
  // a large sphere (radius well outside the data band) so parallax is
  // minimal and they stay out of the way when the user orbits close.
  _addStarfield() {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    const rand = (a, b) => a + Math.random() * (b - a);
    for (let i = 0; i < N; i++) {
      // Uniform point on a sphere, radius jittered so they don't all sit
      // on one shell.
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const r = rand(18, 40);
      const s = Math.sqrt(1 - u * u);
      pos[i * 3 + 0] = r * s * Math.cos(phi);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(phi);
      // Most stars neutral white; a small fraction leans cool blue or
      // warm rose so the field reads as a real sky, not a grid of dots.
      const tint = Math.random();
      let rC, gC, bC;
      if (tint < 0.65) { rC = 1.0; gC = 1.0; bC = 1.0; }
      else if (tint < 0.85) { rC = 0.72; gC = 0.85; bC = 1.0; }
      else { rC = 1.0; gC = 0.78; bC = 0.86; }
      // Brightness: bimodal — mostly mid, some bright so a few stand out.
      const b = Math.random() < 0.85 ? rand(0.55, 0.9) : rand(1.0, 1.4);
      col[i * 3 + 0] = rC * b;
      col[i * 3 + 1] = gC * b;
      col[i * 3 + 2] = bC * b;
      sizes[i] = rand(0.12, 0.25);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute("size", new THREE.Float32BufferAttribute(sizes, 1));

    // Custom shader — PointsMaterial's `size` is global, but we want
    // per-star sizes so a few "galaxies" can stand out.
    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        attribute float size;
        varying vec3 vCol;
        void main() {
          vCol = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (900.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vCol;
        void main() {
          // Round soft-edged points; alpha falls off from centre so
          // stars don't look like pixelated squares.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          float a = smoothstep(0.5, 0.15, r);
          gl_FragColor = vec4(vCol, a * 0.8);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._stars = new THREE.Points(geo, mat);
    this._stars.renderOrder = -1;  // draw before data points
    this.scene.add(this._stars);
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

  render(runs, opts = {}) {
    // Cache so `setPage` can re-render the same data with a different
    // window offset without another fetch.
    this._lastRuns = runs;
    if (opts.pageStart != null) this._pageStart = opts.pageStart;
    if (this._pageStart == null) this._pageStart = 0;
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
    this._hoveredGroup = null;
    this._hoveredMesh = null;
    this._columnMeshes = null;
    this._lockedColumn = null;
    this._locked = null;
    this._byIdx = new Map();
    this._idxByTs = new Map();
    if (this._cursorPlane) this._cursorPlane.visible = false;
    if (this._lockedPlane) this._lockedPlane.visible = false;
    // Cancel any running flyover from a previous dataset.
    if (this._flyTimer) { clearTimeout(this._flyTimer); clearInterval(this._flyTimer); this._flyTimer = null; }
    if (this._flyEaseRAF) { cancelAnimationFrame(this._flyEaseRAF); this._flyEaseRAF = null; }
    this._flyList = [];
    this._flyIdx = 0;
    this._flyState = "idle";
    if (!runs || runs.length === 0) return;

    // Auto-detect which run-level dimensions *vary* across the fetched
    // runs; those become part of series identity so e.g. the same test
    // on Intel and ARM render as distinct Z-lanes. A dimension with a
    // single distinct value collapses out (one branch → no split).
    //
    // Scope: every attribute key the data carries, plus ``branch``.
    // The backend-side facet endpoint does the same dynamic discovery,
    // so a parser introducing a new config key (threads, args, vus,
    // clients, iterations, …) becomes a Z-split automatically. We
    // don't fan out the axis with empty combos — only series that
    // actually have a run under them get a lane (the ``series`` Map
    // below takes care of that by construction).
    const distinctByKey = new Map();
    const bump = (key, val) => {
      if (val == null || val === "") return;
      if (!distinctByKey.has(key)) distinctByKey.set(key, new Set());
      distinctByKey.get(key).add(val);
    };
    for (const run of runs) {
      const commit = run.commit || {};
      const runBlock = run.run || {};
      bump("branch",   commit.ref);
      bump("runner",   runBlock.runner);
      bump("workflow", runBlock.workflow);
      for (const [k, v] of Object.entries((run.test || {}).params || {})) {
        bump(k, v);
      }
    }
    const splitBy = [];
    for (const [key, vals] of distinctByKey) {
      if (vals.size > 1) splitBy.push(key);
    }
    splitBy.sort();
    // Remember the splitBy order so ``hoverSeriesMatching`` can map
    // a (dim, value) pair back to the set of series that match.
    this._splitBy = splitBy;

    // Gather series (test_name, metric_name, ...splitBy) -> info.
    const series = new Map();
    for (const run of runs) {
      const commit = run.commit || {};
      for (const m of run.metrics || []) {
        const k = seriesKey(run, m, splitBy);
        if (!series.has(k)) {
          series.set(k, {
            test_name: (run.test || {}).test_name || "?",
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
        // Commit time is the authoritative ordering signal — stored
        // as an epoch int on ``run.commit.commit_time``.
        const ts = (typeof commit.commit_time === "number")
          ? commit.commit_time * 1000
          : NaN;
        entry.times.push(ts);
        entry.commits.push(commit);
      }
    }

    // Global time bounds.
    let tMin = Infinity, tMax = -Infinity;
    for (const s of series.values()) {
      for (const t of s.times) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    }

    // Primary window: time range the user is currently focused on.
    // Primary-window commits land in positive X [0, axisX]; older
    // commits extend into negative X as a fading tail. The window
    // defaults to the last `primaryDays` but can be set externally
    // via setPrimaryWindow (driven by the time-range slider).
    const DAY_MS = 86400 * 1000;
    const defaultPrimaryStart = tMax - this.primaryDays * DAY_MS;
    const primaryEnd = this._primaryUntil ?? tMax;
    const primaryStart = this._primarySince ?? defaultPrimaryStart;
    const primarySpan = Math.max(1, primaryEnd - primaryStart);
    // Anything older than primaryStart fades into negative X.
    const pastSpan = Math.max(1, primaryStart - tMin);

    // Per-series mean (for Y scaling), variance (tertiary sort key),
    // and first/last timestamp (primary + secondary sort keys).
    // Y is scaled relative to the mean: flat-with-noise looks flat; a 20%
    // excursion reaches ~20% of the half-axis. Min/max stretch was misleading
    // (it turned pure noise into visual trends).
    const Y_GAIN = this.axisY;  // ±100% deviation fills ±half of Y axis
    for (const s of series.values()) {
      const mean = s.values.reduce((a, b) => a + b, 0) / s.values.length;
      s.mean = mean;
      const denom = Math.max(1e-9, Math.abs(mean));
      s.variance = variance(s.values.map(v => v / denom));
      // s.times is populated by commit.commit_time and may contain NaN
      // when a run lacked a commit — skip those for min/max purposes.
      let lo = Infinity, hi = -Infinity;
      for (const t of s.times) {
        if (!isFinite(t)) continue;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
      s.firstTs = isFinite(lo) ? lo : 0;
      s.lastTs  = isFinite(hi) ? hi : 0;
    }

    // Z-axis ordering (composed sort, applied as a single tuple):
    //   1. ``lastTs`` ascending — series whose *newest* point is older
    //      than others come first. That puts discontinued tests at the
    //      front of the list, so they're shown on the first page even
    //      though their numbers are static.
    //   2. ``firstTs`` ascending — once ``lastTs`` ties, series whose
    //      *oldest* point is older than others come first. Long-running
    //      veterans — the ones that have been benchmarked the longest —
    //      surface next.
    //   3. variance descending — the tertiary tiebreaker, matching the
    //      previous behaviour of "live action in front."
    // Hard cap on rendered series: past ~200 the Z-axis crowding makes
    // the scene unreadable and the browser slow. The pager shows later
    // pages on demand.
    const MAX_SERIES = 200;
    const sorted = [...series.keys()].sort((a, b) => {
      const sa = series.get(a), sb = series.get(b);
      if (sa.lastTs !== sb.lastTs) return sa.lastTs - sb.lastTs;
      if (sa.firstTs !== sb.firstTs) return sa.firstTs - sb.firstTs;
      return sb.variance - sa.variance;
    });
    const totalSeries = sorted.length;
    // Clamp page window so it always lands on a valid range. The last
    // page is [max(0, total - MAX), total); earlier pages are full.
    const pageStart = Math.max(
      0, Math.min(this._pageStart, Math.max(0, totalSeries - MAX_SERIES)));
    this._pageStart = pageStart;
    const keys = sorted.slice(pageStart, pageStart + MAX_SERIES);
    const zStep = keys.length > 1 ? this.axisZ / (keys.length - 1) : this.axisZ;

    // Marker size: min 0.45 × tighter neighbor spacing (so dense data
    // fits), max 0.012 absolute (so sparse data — or time slices —
    // can't grow dots to blobs). Between those bounds it scales with
    // actual spacing.
    const allTimesSet = new Set();
    for (const run of runs) {
      const ct = (run.commit || {}).commit_time;
      if (typeof ct === "number") allTimesSet.add(ct * 1000);
    }
    const commitTimes = [...allTimesSet].sort((a, b) => a - b);
    const nCommits = commitTimes.length;

    // Split commits into primary (inside [primaryStart, primaryEnd])
    // and tail (older than primaryStart). X spacing is sized for the
    // primary set so it always fills [0, axisX]; the tail uses the
    // same step but laid out into negative X (newest tail nearest 0).
    const primaryTimes = commitTimes.filter(t => t >= primaryStart && t <= primaryEnd);
    const tailTimes = commitTimes.filter(t => t < primaryStart);
    const nPrimary = primaryTimes.length;
    const xSpacingNatural = nPrimary > 1
      ? this.axisX / (nPrimary - 1)
      : (nCommits > 1 ? this.axisX / (nCommits - 1) : this.axisX);
    const markerSize = Math.min(0.010, Math.min(zStep, xSpacingNatural) * 0.45);

    // X mapping: primary-window commits span [0, axisX] ordinally,
    // older commits extend into negative X as a fading tail.
    // Spacing bounded above at 50 × markerSize so sparse primary
    // windows cluster (not stretched across the whole axis) but can
    // still breathe.
    const xStep = Math.min(xSpacingNatural, markerSize * 50);
    const xByTs = new Map();
    primaryTimes.forEach((t, i) => xByTs.set(t, i * xStep));
    // Tail laid out backwards from the primary's left edge — newest
    // tail commit at -xStep, oldest further out. We use 0.7× step on
    // the tail so it compresses slightly and reads as receding past.
    // Bounded by |min(x)| < max(x): the tail never extends further
    // left than the primary reaches right. Older commits beyond that
    // bound get no x-position and are skipped at render time.
    const tailStep = xStep * 0.7;
    const primaryXMax = Math.max(0, (nPrimary - 1) * xStep);
    const maxTailCount = Math.floor(primaryXMax / tailStep - 1e-9);
    [...tailTimes].reverse().slice(0, maxTailCount).forEach((t, i) =>
      xByTs.set(t, -(i + 1) * tailStep));
    const globalIdxByTs = new Map(commitTimes.map((t, i) => [t, i]));

    // Enlargement caps. A hovered / column / CP marker must never draw
    // larger than these fractions of neighbor spacing, so we never see
    // overlap in dense data. Stored on the instance so `_applyMeshState`
    // can use them for every per-mesh update between renders.
    // Highlighted markers cap by category. Plain 1→2.5 and CP 2→5
    // give the same 2.5× pop on highlight. A CP that is BOTH in the
    // selected column AND the direct hover target pops further (→ 7),
    // since it's the single most interesting point on screen at that
    // moment. Crowded scenes will overlap a neighbor or two —
    // accepted cost.
    this._markerMaxScale = 2.5;
    this._markerMaxScaleCP = 5;
    this._markerMaxScaleCPFocus = 7;

    // First-data render: re-center orbit on the data. The constructor
    // targets scene-center, which was fine when data filled the axis;
    // with the newest-anchored ordinal mapping, sparse data clusters at
    // the right edge and rotation feels over-sensitive because the
    // pivot has a long arm to the visible cluster. Shift target +
    // camera by the same delta so the user keeps their relative pose
    // but the orbit now pivots on what they're looking at. We only do
    // this once; filter changes keep the user's view.
    if (!this._didInitialCenter && nPrimary > 0) {
      this._didInitialCenter = true;
      // Pivot on the primary window's midpoint, not the full data —
      // the tail into negative X should feel like it recedes past the
      // frame, not drag the camera back with it.
      const cx = (nPrimary - 1) * xStep / 2;
      const newTarget = new THREE.Vector3(cx, this.axisY / 2, this.axisZ / 2);
      const controls = this.camController.controls;
      const delta = newTarget.clone().sub(controls.target);
      this.camera.position.add(delta);
      controls.target.copy(newTarget);
      controls.update();
      this._initialCamOffset = this.camera.position.clone().sub(newTarget);
    }

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
      // dimValues: {dim_name: value} — the facet-dim→value projection
      // used by hoverSeriesMatching to light up every series sharing
      // a (dim, value) with a hovered facet row. Includes test_name
      // and metric (always in series identity) plus each splitBy key.
      const dimValues = {
        test_name: s.test_name,
        metric: s.metric,
      };
      for (let i2 = 0; i2 < splitBy.length; i2++) {
        dimValues[splitBy[i2]] = s.splitVals[i2];
      }
      this._seriesInfo[zi] = {
        key: k, zi, name: series_name, color: lineHex,
        dimValues,
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
        cpIdx = cp.i;  // series-local index into s.values / s.times
        cpDeltaPct = (cp.after - cp.before) / Math.max(Math.abs(cp.before), 1e-9);
        cpIsRegression = (s.direction === "higher_is_better") ? (cpDeltaPct < 0) : (cpDeltaPct > 0);
        // Flyover groups by commit (globalIdx), so store that as `idx`.
        const cpGlobalIdx = globalIdxByTs.get(s.times[cpIdx]);
        cpEntry = { zi, idx: cpGlobalIdx, deltaPct: cpDeltaPct, regression: cpIsRegression, mesh: null };
        this._changePoints.push(cpEntry);
      }

      const linePos = [];
      // Track where the CP landed in linePos after skips, because
      // we skip observations whose commits exceed the tail cap and
      // that desynchronises linePos-index from s.values-index.
      let cpLinePosIdx = -1;
      for (let i = 0; i < s.values.length; i++) {
        const ts = s.times[i];
        const x = xByTs.get(ts);
        // Commits outside the primary window AND beyond the tail cap
        // get no x-slot; drop the observation entirely.
        if (x === undefined) continue;
        // Coloring still follows wall-clock time: primary-window points
        // get the bright gradient, past points fade into grayscale.
        let color, emissiveFactor;
        if (ts >= primaryStart) {
          const t = (ts - primaryStart) / primarySpan;
          if (tier === "C") {
            color = tierColor.clone();
          } else {
            color = tier === "A" ? timeColor(t) : timeGrayColor(t);
            color.lerp(_srgb(1, 1, 1), whitenAmount(t));
          }
          emissiveFactor = Math.pow(t, 2.2);
        } else {
          const backT = (primaryStart - ts) / pastSpan;
          if (tier === "C") {
            color = tierColor.clone().lerp(DARK_BG, Math.pow(backT, 1.2));
          } else {
            color = pastColor(backT);
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
        const globalIdx = globalIdxByTs.get(ts);
        mesh.userData = {
          isPoint: true,
          series: k, zi, idx: globalIdx, localIdx: i,
          series_name, test_name: s.test_name, metric: s.metric,
          kind,
          unit: s.unit, direction: s.direction,
          value: s.values[i], timestamp: s.times[i],
          commit: s.commits[i],
          baseScale,
          _baseOpacity: mat.opacity,
          isChangePoint: isCp,
          isCpNeighbor: isPreCp,
          ...(isCp ? {
            cpBefore: cp.before, cpAfter: cp.after,
            cpDeltaPct, regression: cpIsRegression,
          } : {}),
        };
        this.pointsGroup.add(mesh);
        if (isCp && cpEntry) cpEntry.mesh = mesh;
        // Column index: meshes sharing a commit timestamp (same globalIdx)
        // are the "column" the time-cursor plane highlights.
        if (!this._byIdx.has(globalIdx)) this._byIdx.set(globalIdx, []);
        this._byIdx.get(globalIdx).push(mesh);
        // Stable cross-process index for external callers (see
        // _idxByTs comment in the constructor).
        this._idxByTs.set(ts, globalIdx);
        if (isCp) cpLinePosIdx = linePos.length / 3;
        linePos.push(x, y, z);
      }

      if (linePos.length >= 6) {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        // Split the line at the change-point index, if any. The "before"
        // segment is rendered thicker and in the CP color (red for a
        // regression, green for an improvement) so the direction of the
        // step reads at a glance. Both segments share the CP vertex so
        // there's no visible gap.
        // Split uses the CP's *rendered* line-position index, not its
        // original series index — the two diverge when we drop points
        // beyond the tail cap.
        const hasSplit = cpLinePosIdx > 0 && cpLinePosIdx < (linePos.length / 3) - 1;

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
          const beforePos = linePos.slice((cpLinePosIdx - 1) * 3, (cpLinePosIdx + 1) * 3);
          const cpCol = cpIsRegression ? CP_REGRESSION : CP_IMPROVEMENT;
          const beforeMat = new LineMaterial({
            color: cpCol,
            linewidth: 3.5,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
          });
          beforeMat.resolution.set(w, h);
          const beforeGeo = new LineGeometry();
          beforeGeo.setPositions(beforePos);
          const beforeLine = new Line2(beforeGeo, beforeMat);
          // Draw above the tier-colored main line so the CP segment stays
          // red/green even when the main line thickens to HOT width.
          beforeLine.renderOrder = 10;
          beforeLine.userData = { baseOpacity: 0.7, baseWidth: 3.5 };
          this.pointsGroup.add(beforeLine);
          this._cpBeforeLines[zi] = beforeLine;
        }
      }
    });

    this.narrator.emit({
      type: "render_complete",
      series_count: keys.length,
      total_series: totalSeries,
      page_start: pageStart,
      page_size: MAX_SERIES,
      point_count: this.pointsGroup.children.length,
      series: this.getSeries(),
      change_points: this._changePoints.length,
    });
    this._requestRender();
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

  /**
   * Highlight every series whose identity matches (dim, value). Used
   * when the user hovers a facet-filter row on the left panel — e.g.
   * hovering "threads · 8" lights up every series sharing that
   * dim/value (possibly across many test_names / metrics), and dims
   * everything else. No neighbor warm-up; it's a "set lighting"
   * pattern, not a "follow the pointer" pattern.
   *
   * ``dim`` is the facet-key name (``test_name``, ``metric``, or any
   * splitBy key like ``args`` / ``threads`` / ``runner``). ``value``
   * is compared with ``String()`` coercion — facet rows are text, the
   * underlying data may be int/str mixed.
   */
  hoverSeriesMatching(dim, value) {
    const want = String(value);
    const set = new Set();
    for (const info of this._seriesInfo) {
      if (!info) continue;
      if (String(info.dimValues[dim]) === want) set.add(info.zi);
    }
    this._hoveredGroup = set.size > 0 ? set : null;
    this._applyHoverState();
  }

  clearHoverGroup() {
    if (this._hoveredGroup === null || this._hoveredGroup === undefined) return;
    this._hoveredGroup = null;
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
    this._requestRender();
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
        // Hovered off-column: grow to 3× default so the affordance
        // matches what the demo used. The 3-cap covers us if any
        // base is high enough to make 3× base overshoot.
        scale = Math.max(scale, base * 3);
      }
    }
    // Cap by category: plain → 2.5, CP/preCP → 5, CP that's BOTH the
    // hover subject AND in the selected column → 7 so it stands out
    // in its own row.
    const isBig = m.userData.isChangePoint || m.userData.isCpNeighbor;
    let cap;
    if (isBig) {
      const hotInCol = isHot && (inLocked || inHover);
      cap = hotInCol
        ? (this._markerMaxScaleCPFocus ?? this._markerMaxScaleCP ?? Infinity)
        : (this._markerMaxScaleCP ?? Infinity);
    } else {
      cap = this._markerMaxScale ?? Infinity;
    }
    scale = Math.min(scale, cap);
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
    this._flyState = "paused";
    this._emitFlyover();
  }

  _startCountdown() {
    this._cancelFlyoverTimers();
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
      // End of tour — rewind to stop 0 (the overview pose) and start
      // a fresh countdown so the tour loops indefinitely. Honours
      // requestAnimationFrame's throttling when the tab is
      // backgrounded, so a hidden tab won't burn CPU looping.
      this._flyIdx = 0;
      this._goToCp(0);
      this._startCountdown();
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
      this._requestRender();
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
    // Group hover overrides pointer hover: every series in the set is
    // HOT, everything else DIM, no neighbor warmth.
    const group = this._hoveredGroup;
    const setTargets = (line, i) => {
      if (!line) return;
      const baseOp = line.userData.baseOpacity ?? this._lineBaseOpacity;
      const baseW  = line.userData.baseWidth   ?? this._lineBaseWidth;
      let op, w;
      const isLocked = lockedZis ? lockedZis.has(i) : false;
      if (group) {
        if (group.has(i) || isLocked) { op = Math.max(baseOp, HOT); w = Math.max(baseW, HOT_W); }
        else                          { op = Math.min(baseOp, DIM_OP); w = baseW; }
      } else if (this._hoveredZi === -1) {
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
    this._requestRender();
  }

  _requestRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(this._animate);
  }

  _animate() {
    this._rafId = null;
    // Hover ease: snap *up* to the highlight instantly, but glide *down*
    // over ~2.5s so de-hovered series don't flash off like lightning.
    // Linear fade so the tail drops to target instead of lingering
    // asymptotically. In locked mode, snap — decisive feel.
    const snap = !!this._locked;
    const OP_STEP = 0.045;
    const W_STEP  = 0.18;
    let stillEasing = false;
    const easeLine = (line) => {
      if (!line || line.userData._targetOpacity == null) return;
      const mat = line.material;
      const curOp = mat.opacity;
      const tgtOp = line.userData._targetOpacity;
      if (tgtOp >= curOp || snap) { mat.opacity = tgtOp; }
      else { mat.opacity = Math.max(tgtOp, curOp - OP_STEP); stillEasing = true; }
      const curW = mat.linewidth;
      const tgtW = line.userData._targetWidth;
      if (tgtW != null) {
        if (tgtW >= curW || snap) { mat.linewidth = tgtW; }
        else { mat.linewidth = Math.max(tgtW, curW - W_STEP); stillEasing = true; }
      }
    };
    for (const line of this._seriesLines) easeLine(line);
    for (const line of this._cpBeforeLines) easeLine(line);
    // camController.update() drives damping; if the camera actually moves
    // it fires a 'change' event which calls _requestRender() for the next frame.
    this.camController.update();
    // Lock the starfield fully to the camera (position + orientation)
    // so the sky stays screen-fixed. Makes the user feel in control of
    // the data rather than a passenger on a moving universe.
    if (this._stars) {
      this._stars.position.copy(this.camera.position);
      this._stars.quaternion.copy(this.camera.quaternion);
    }
    this.renderer.render(this.scene, this.camera);
    // Keep the loop alive only while line opacity/width is still gliding.
    // Camera movement self-perpetuates via the 'change' listener above.
    if (stillEasing) this._requestRender();
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
    this._requestRender();
  }

  setPage(pageStart) {
    if (!this._lastRuns) return;
    this.render(this._lastRuns, { pageStart });
  }

  // Public hooks for UI elements (like the commit-tick bar on the
  // slider) to drive the same hover / lock behavior we already have
  // for pointer interaction inside the 3D scene.
  hoverCommitByIdx(idx) {
    const col = this._byIdx.get(idx);
    if (!col || !col.length) return false;
    this._updateTimeCursor(col[0]);
    this.narrator.emit({ type: "point_hovered", point: col[0].userData });
    return true;
  }
  // Hover by commit timestamp (ms). Stable across window changes —
  // external callers (e.g. the SHA-strip hover bar) should use this
  // rather than ``hoverCommitByIdx``, whose ``idx`` is internal to
  // the current render.
  hoverCommitByTs(ts) {
    const idx = this._idxByTs.get(ts);
    if (idx === undefined) return false;
    return this.hoverCommitByIdx(idx);
  }
  clearHover() {
    this._updateTimeCursor(null);
  }
  lockCommitByIdx(idx) {
    const col = this._byIdx.get(idx);
    if (!col || !col.length) return false;
    // Prefer the change-point mesh in the column so the right-hand
    // info box leads with the most interesting row, falling back to
    // any representative mesh.
    const cp = col.find(m => m.userData.isChangePoint) || col[0];
    if (this._flyState === "playing" || this._flyState === "countdown") {
      this.pauseFlyover();
    }
    this._enterLock(cp);
    return true;
  }
  lockCommitByTs(ts) {
    const idx = this._idxByTs.get(ts);
    if (idx === undefined) return false;
    return this.lockCommitByIdx(idx);
  }

  // Set the visible time window. Commits inside [sinceMs, untilMs]
  // get positive-X ordinal spacing; older commits form a tail into
  // negative X. Pass `null` for either bound to unset it.
  setPrimaryWindow(sinceMs, untilMs) {
    this._primarySince = sinceMs;
    this._primaryUntil = untilMs;
    // Recentering is tied to the primary window, so allow it to
    // re-fit when the window meaningfully changes.
    this._didInitialCenter = false;
    if (this._lastRuns) this.render(this._lastRuns);
  }

  async fetchAndRender(url) {
    // Pull server config first so `startFlyover` can honour the
    // `recent_cp_days` window. A missing endpoint just leaves defaults
    // in place — non-fatal.
    try {
      const cr = await fetch("api/v3/config");
      if (cr.ok) {
        const payload = await cr.json();
        // Unwrap JsonEE envelope if present; fall back to plain JSON.
        this.config = payload?.data ?? payload;
      }
    } catch (e) { /* ignore */ }
    this.config = this.config || { recent_cp_days: 14 };

    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const payload = await res.json();
    // Unwrap JsonEE envelope if present; fall back to plain JSON.
    const runs = payload?.data ?? payload;
    // A fresh fetch always lands on page 0 — filter changes shouldn't
    // leave the view stuck on a high-variance page 4 that no longer
    // exists in the narrowed slice.
    this.render(runs, { pageStart: 0 });
    return runs;
  }
}

