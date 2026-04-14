// AudioEngine abstraction. v0 is a no-op. Future impls:
//   - DataDrivenEngine: map metric value -> pitch, timestamp density -> tempo.
//   - CuratedEngine: pre-picked tracks queued to match visual rhythm.
export class AudioEngine {
  start() {}
  stop() {}
  cueChangePoint(_cp) {}
}
