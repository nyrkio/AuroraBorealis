// Narrator: a stream of "interesting things to say" — shoutouts, milestones,
// aggregates. v0 is a simple event bus; later, the analytics layer feeds it.
export class Narrator {
  constructor() { this._subs = []; }
  subscribe(fn) { this._subs.push(fn); return () => { this._subs = this._subs.filter(s => s !== fn); }; }
  emit(event) { for (const fn of this._subs) fn(event); }
}
