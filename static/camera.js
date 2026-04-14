// Camera controllers. v0 ships OrbitController. FlightController is a stub
// that the later "fly-through change points" feature will implement.
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class OrbitController {
  constructor(camera, domElement, target = null) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    if (target) this.controls.target.copy(target);
    this.controls.update();
  }
  setTarget(v) { this.controls.target.copy(v); this.controls.update(); }
  update() { this.controls.update(); }
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
