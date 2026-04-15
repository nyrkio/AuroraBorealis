// Camera controllers. v0 ships OrbitController. FlightController is a stub
// that the later "fly-through change points" feature will implement.
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class OrbitController {
  constructor(camera, domElement, target = null) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    // Default dampingFactor=0.05 is "skating on ice" — the motion
    // continues long after mouseup. 0.15 feels like a hand resting on a
    // globe: responds immediately, settles quickly.
    this.controls.dampingFactor = 0.15;
    // Baseline rotateSpeed; `update()` scales this down when the camera
    // zooms closer to the target so rotation feels proportional to the
    // apparent object size rather than the (fixed) mouse-delta mapping.
    this._baseRotateSpeed = 0.7;
    this.controls.rotateSpeed = this._baseRotateSpeed;
    if (target) this.controls.target.copy(target);
    this.controls.update();
    // Captured after the initial setup so the ratio is against the
    // "home" framing chosen in the constructor.
    this._baselineDist = camera.position.distanceTo(this.controls.target);
  }
  setTarget(v) {
    this.controls.target.copy(v);
    this.controls.update();
    this._baselineDist = this.controls.object.position.distanceTo(v);
  }
  update() {
    // Distance-aware rotate speed: when the camera is close to the data
    // the same mouse delta sweeps a much larger *visible* arc, so the
    // control feels twitchy. Scale rotateSpeed down smoothly as distance
    // shrinks. Cube root keeps extreme zooms from killing rotation
    // entirely; bounds [0.3, 1.5] so the feel never gets silly.
    const dist = this.controls.object.position.distanceTo(this.controls.target);
    const base = this._baselineDist || dist;
    const ratio = Math.max(0.3, Math.min(1.5, Math.cbrt(dist / base)));
    this.controls.rotateSpeed = this._baseRotateSpeed * ratio;
    this.controls.update();
  }
  dispose() { this.controls.dispose(); }
}

export class FlightController {
  // Stub: will ease the camera along a path of change points,
  // firing onApproach(cp) as each is neared.
  constructor(camera, path = [], { onApproach = () => {} } = {}) {
    this.camera = camera;
    this.path = path;
    this.onApproach = onApproach;
  }
  update() { /* no-op in v0 */ }
  dispose() {}
}
