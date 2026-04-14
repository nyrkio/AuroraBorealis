// Unit / name -> geometry mapping. The visual vocabulary.
// Long-term, the Metric schema should carry a `kind` field set by the parser;
// this table is v0 inference so we can move.
import * as THREE from "three";

export function unitToKind(unit, name = "") {
  const u = (unit || "").toLowerCase().trim();
  const n = (name || "").toLowerCase();

  // Duration
  if (["s", "sec", "secs", "second", "seconds",
       "ms", "msec", "millisecond", "milliseconds",
       "us", "usec", "microsecond", "microseconds",
       "ns", "nsec", "nanosecond", "nanoseconds"].includes(u)) return "duration";
  if (/latency|time|duration|wall/.test(n)) return "duration";

  // Throughput / rate
  if (/\/s$|\/sec$|per[_-]?second/.test(u)) return "throughput";
  if (["tps", "qps", "rps", "ops", "ops/s", "hz"].includes(u)) return "throughput";
  if (/throughput|rate|tps|qps|hz|ops/.test(n)) return "throughput";

  // Size / capacity
  if (["b", "kb", "mb", "gb", "tb", "kib", "mib", "gib", "bytes"].includes(u)) return "size";
  if (/size|bytes|memory|ram|artifact|heap|rss/.test(n)) return "size";

  // Ratio / percent
  if (["%", "percent", "ratio", "fraction"].includes(u)) return "ratio";

  // Count (unitless / fallthrough)
  if (["", "count", "n"].includes(u)) return "count";
  return "count";
}

// Geometry factories parameterized by marker radius. The caller picks `size`
// based on data density (see kuutar.js — it keys off the Z-direction spacing
// so markers don't overlap between neighboring series).
const GEOMETRIES = {
  duration:   (size) => new THREE.SphereGeometry(size, 12, 8),
  throughput: (size) => {
    // Cone pointing toward +X (direction of flowing time). Tall and narrow
    // so it reads as a dart / arrow rather than a blob.
    const g = new THREE.ConeGeometry(size * 0.7, size * 2.2, 10);
    g.rotateZ(-Math.PI / 2);
    return g;
  },
  size:       (size) => new THREE.BoxGeometry(size * 1.4, size * 1.4, size * 1.4),
  ratio:      (size) => new THREE.CylinderGeometry(size, size, size * 0.3, 12),
  count:      (size) => new THREE.OctahedronGeometry(size),
};

export function geometryFor(kind, size) {
  return (GEOMETRIES[kind] || GEOMETRIES.count)(size);
}
