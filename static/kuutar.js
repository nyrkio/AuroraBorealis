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

// Time-based colormap: newest = shiny silver/cyan, fading backward through
// calm blues, pale gray, to near-black at the oldest timestamp.
// Gradient within the primary window (t=0 at the x=0 boundary, t=1 at now):
//   medium-dark gray → pale gray → white → blue → stronger blue → electric blue
// The t=0 value is chosen so the past-side gradient (see pastColor) continues
// from the same color — no visual jump crossing the x=0 boundary.
const TIME_STOPS = [
  [0.00, [0x3a, 0x3a, 0x40]],  // medium-dark gray (meets pastColor at boundary)
  [0.15, [0x70, 0x74, 0x78]],  // pale gray
  [0.32, [0xd0, 0xd4, 0xd8]],  // near white
  [0.55, [0x3a, 0x78, 0xb0]],  // medium blue
  [0.75, [0x40, 0xa0, 0xe8]],  // strong blue
  [0.90, [0x78, 0xc8, 0xff]],  // electric blue
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
// How much to lift the primary color toward white as a smooth function of t.
// 0 for the newest ~15% (keeps full blue/silver intent), ramps to 0.40 for
// t <= 0.65 — no visible seam around the "last 25%" threshold.
function whitenAmount(t) {
  const x = Math.max(0, Math.min(1, (t - 0.65) / 0.20));
  const smooth = x * x * (3 - 2 * x);
  return 0.40 * (1 - smooth);
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

// Categorical palette for per-series line colors. Exposed so the HTML legend
// can draw matching swatches next to each series name.
export const SERIES_PALETTE = [
  0x4e79a7, 0xf28e2c, 0xe15759, 0x76b7b2, 0x59a14f,
  0xedc949, 0xaf7aa1, 0xff9da7, 0x9c755f, 0xbab0ab,
  0x6baed6, 0xfd8d3c,
];

export function seriesHexColor(zi) {
  return SERIES_PALETTE[zi % SERIES_PALETTE.length];
}

function variance(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let s = 0;
  for (const x of xs) s += (x - mean) ** 2;
  return s / xs.length;
}

function seriesKey(run, metric) {
  return `${run.attributes?.test_name || "?"}|${metric.name}`;
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

    // Hover/picking state.
    this._seriesLines = [];   // zi -> Line (populated each render)
    this._hoveredZi = -1;
    this._lineBaseOpacity = 0.10;
    this._lineBaseWidth = 1;  // pixels
    this._raycaster = new THREE.Raycaster();
    this._mouseNdc = new THREE.Vector2();
    this.renderer.domElement.addEventListener("pointermove", (e) => this._onPointerMove(e));
    this.renderer.domElement.addEventListener("pointerleave", () => this._clearHover());

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
    this._seriesInfo = [];
    this._changePoints = [];
    this._hoveredZi = -1;
    this._hoveredMesh = null;
    if (!runs || runs.length === 0) return;

    // Gather series (test_name, metric_name) -> info.
    const series = new Map();
    for (const run of runs) {
      for (const m of run.metrics || []) {
        const k = seriesKey(run, m);
        if (!series.has(k)) {
          series.set(k, {
            test_name: run.attributes?.test_name || "?",
            metric: m.name,
            unit: m.unit,
            direction: m.direction || inferDirection(unitToKind(m.unit, m.name)),
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

    keys.forEach((k, zi) => {
      const s = series.get(k);
      const kind = unitToKind(s.unit, s.metric);
      const geo = geometryFor(kind, markerSize);
      const series_name = `${s.test_name} · ${s.metric}`;
      this._seriesInfo[zi] = {
        key: k, zi, name: series_name, color: seriesHexColor(zi),
      };

      // Detect the series' most prominent step change up front so each
      // marker knows whether it is THE change point and whether that
      // change is a regression or an improvement.
      const cp = detectChangePoint(s.values);
      let cpIdx = -1, cpDeltaPct = 0, cpIsRegression = false;
      if (cp) {
        cpIdx = cp.i;
        cpDeltaPct = (cp.after - cp.before) / Math.max(Math.abs(cp.before), 1e-9);
        // Direction inversion: for lower_is_better, an increase is bad;
        // for higher_is_better, a decrease is bad.
        cpIsRegression = (s.direction === "higher_is_better") ? (cpDeltaPct < 0) : (cpDeltaPct > 0);
        this._changePoints.push({ zi, idx: cpIdx, deltaPct: cpDeltaPct, regression: cpIsRegression });
      }

      const linePos = [];
      for (let i = 0; i < s.values.length; i++) {
        const ts = s.times[i];
        let x, color, emissiveFactor;
        if (ts >= primaryStart) {
          const t = (ts - primaryStart) / primarySpan;
          x = t * this.axisX;
          color = timeColor(t);
          color.lerp(_srgb(1, 1, 1), whitenAmount(t));
          emissiveFactor = Math.pow(t, 2.2);
        } else {
          const backT = (primaryStart - ts) / pastSpan;
          x = -backT * (pastSpan / primarySpan) * this.axisX;
          color = pastColor(backT);
          emissiveFactor = 0;
        }
        const denom = Math.max(1e-9, Math.abs(s.mean));
        const y = this.axisY / 2 + ((s.values[i] - s.mean) / denom) * (Y_GAIN / 2);
        const z = zi * zStep;

        // Change-point markers override the time-based color with a strong
        // red/green and get a permanent 2x scale (applied via mesh.scale, not
        // geometry, so hover scaling can compose cleanly).
        const isCp = i === cpIdx;
        const markerColor = isCp ? (cpIsRegression ? CP_REGRESSION : CP_IMPROVEMENT) : color;
        const mat = new THREE.MeshStandardMaterial({
          color: markerColor,
          metalness: isCp ? 0.5 : 0.9,
          roughness: isCp ? 0.35 : 0.28,
          emissive: markerColor,
          emissiveIntensity: isCp ? 0.7 : emissiveFactor * 0.75,
          opacity: isCp ? 0.95 : 0.75,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        const baseScale = isCp ? 2 : 1;
        mesh.scale.setScalar(baseScale);
        mesh.userData = {
          series: k, zi, idx: i,
          series_name, test_name: s.test_name, metric: s.metric,
          unit: s.unit, direction: s.direction,
          value: s.values[i], timestamp: s.times[i],
          commit: s.commits[i],
          baseScale,
          isChangePoint: isCp,
          ...(isCp ? {
            cpBefore: cp.before, cpAfter: cp.after,
            cpDeltaPct, regression: cpIsRegression,
          } : {}),
        };
        this.pointsGroup.add(mesh);
        linePos.push(x, y, z);
      }

      if (linePos.length >= 6) {
        const lineGeo = new LineGeometry();
        lineGeo.setPositions(linePos);
        const hex = seriesHexColor(zi);
        const seriesColor = _srgb(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);
        const lineMat = new LineMaterial({
          color: seriesColor,
          linewidth: this._lineBaseWidth,  // pixels (LineMaterial convention)
          transparent: true,
          opacity: this._lineBaseOpacity,
          depthWrite: false,
        });
        lineMat.resolution.set(this.container.clientWidth, this.container.clientHeight);
        const line = new Line2(lineGeo, lineMat);
        this.pointsGroup.add(line);
        this._seriesLines[zi] = line;
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
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._mouseNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouseNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouseNdc, this.camera);
    const meshes = this.pointsGroup.children.filter(c => c.isMesh);
    const hits = this._raycaster.intersectObjects(meshes, false);
    const mesh = hits.length > 0 ? hits[0].object : null;
    const zi = mesh ? mesh.userData.zi : -1;
    this._setHoveredMesh(mesh);
    this.hoverSeries(zi);
  }

  _setHoveredMesh(mesh) {
    if (mesh === this._hoveredMesh) return;
    // Restore previous.
    if (this._hoveredMesh) {
      const prev = this._hoveredMesh;
      prev.scale.setScalar(prev.userData.baseScale || 1);
    }
    this._hoveredMesh = mesh;
    if (mesh) {
      // Hover scale: 1.6x on top of base — normal points pop to 1.6x,
      // change points (base=2) grow to 3.2x. Enough to read at any angle.
      mesh.scale.setScalar((mesh.userData.baseScale || 1) * 1.6);
      this.narrator.emit({ type: "point_hovered", point: mesh.userData });
    }
  }

  _clearHover() {
    this._setHoveredMesh(null);
    this.hoverSeries(-1);
  }

  _applyHoverState() {
    const HOT = 0.95, WARM = 0.65, DIM = 0.08;
    const HOT_W = 3.5, WARM_W = 2, DIM_W = 1;
    for (let i = 0; i < this._seriesLines.length; i++) {
      const line = this._seriesLines[i];
      if (!line) continue;
      let op, w;
      if (this._hoveredZi === -1) {
        op = this._lineBaseOpacity; w = this._lineBaseWidth;
      } else {
        const d = Math.abs(i - this._hoveredZi);
        op = d === 0 ? HOT : (d === 1 ? WARM : DIM);
        w  = d === 0 ? HOT_W : (d === 1 ? WARM_W : DIM_W);
      }
      line.userData._targetOpacity = op;
      line.userData._targetWidth = w;
    }
    this.narrator.emit({ type: "hover_changed", zi: this._hoveredZi });
  }

  _animate() {
    // Hover ease: snap *up* to the highlight instantly, but glide *down*
    // over ~2.5s so de-hovered series don't flash off like lightning.
    const FADE_DOWN = 0.02;
    for (const line of this._seriesLines) {
      if (!line || line.userData._targetOpacity == null) continue;
      const mat = line.material;
      const curOp = mat.opacity;
      const tgtOp = line.userData._targetOpacity;
      if (tgtOp >= curOp) {
        mat.opacity = tgtOp;
      } else if (curOp - tgtOp > 0.001) {
        mat.opacity = curOp + (tgtOp - curOp) * FADE_DOWN;
      }
      const curW = mat.linewidth;
      const tgtW = line.userData._targetWidth;
      if (tgtW != null) {
        if (tgtW >= curW) mat.linewidth = tgtW;
        else if (curW - tgtW > 0.01) mat.linewidth = curW + (tgtW - curW) * FADE_DOWN;
      }
    }
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
  }

  async fetchAndRender(url) {
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
