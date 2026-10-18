// A run, as its events arrive from /api/run (see src/events.ts): rows of segments, one row
// per step or crate, on the server's clock.

export const STEP_LABELS = { resolve: 'Resolve versions', compile: 'Compile the snippet', link: 'Link', run: 'Run the program' };
export const crateOf = (id) => { const at = id.lastIndexOf('@'); return { name: id.slice(0, at), version: id.slice(at + 1) }; };

export class Run {
  constructor({ check = false, recorded = false } = {}) {
    this.check = check;
    this.recorded = recorded;
    this.rows = new Map();
    this.order = [];
    this.tally = { hit: 0, r2: 0, miss: 0 };
    /** Lookups that stand for a step: of the resolution, the dependencies, the build. */
    this.lookups = {};
    this.offset = null;
    this.last = 0;
    this.done = false;
    this.result = null;
    this.error = null;
  }
  /** Milliseconds into the run, on the server's clock. */
  now() {
    if (this.done || this.offset == null) return this.last;
    return Math.max(this.last, performance.now() - this.offset);
  }
  row(key, init) {
    let r = this.rows.get(key);
    if (!r) { r = { key, segs: [], ...init }; this.rows.set(key, r); this.order.push(key); }
    return r;
  }
  add(e, arrivedAt = performance.now()) {
    if (e.t != null) {
      this.last = Math.max(this.last, e.t);
      if (this.offset == null) this.offset = arrivedAt - e.t;
    }
    const t = e.t ?? this.last;
    switch (e.type) {
      case 'step': {
        if (e.step === 'deps') {
          // Every crate in one lookup: one row for all of them.
          const found = this.lookups.deps;
          if (e.state === 'end' && found && found.outcome !== 'miss') {
            const n = this.units().length;
            this.rows.set('deps', { key: 'deps', kind: 'step', label: `All ${n} crates`, cached: true, outcome: found.outcome, start: found.start, end: found.end, segs: [{ cls: found.outcome, start: found.start, end: found.end }] });
          }
          break;
        }
        const r = this.row(e.step, { kind: 'step', label: STEP_LABELS[e.step] });
        if (e.cached) {
          // From the cache: drawn as the lookup that found it.
          const found = this.lookups.build;
          r.cached = true;
          r.outcome = found?.outcome ?? 'hit';
          r.start = found?.start ?? t;
          r.end = found?.end ?? t;
          r.ok = e.ok;
          r.segs = [{ cls: r.outcome, start: r.start, end: r.end }];
        } else if (e.state === 'start') {
          r.start = t;
          r.segs.push({ cls: e.step === 'run' ? 'run' : 'compiler', start: t });
        } else {
          r.end = t;
          r.ok = e.ok;
          const seg = r.segs.at(-1);
          if (seg) {
            seg.end = t;
            if (!e.ok && e.step !== 'run') seg.cls = 'bad';
            if (e.step === 'resolve' && this.lookups.resolve?.outcome === 'hit') seg.cls = 'hit';
          }
        }
        break;
      }
      case 'cache': {
        this.tally[e.outcome]++;
        const lookup = { outcome: e.outcome, start: t - e.ms, end: t, ms: e.ms };
        if (e.what === 'unit') this.unitRow(e.id).lookup = lookup;
        else this.lookups[e.what] = lookup;
        break;
      }
      case 'unit': {
        const r = this.unitRow(e.id);
        if (e.state === 'start') {
          r.start = t;
          r.segs.push({ cls: 'span', start: t });
          break;
        }
        Object.assign(r, { end: t, ok: e.ok, cached: e.cached, procMacro: e.procMacro, buildScript: e.buildScript });
        const span = r.segs.find((s) => s.cls === 'span');
        if (span) span.end = t;
        if (e.cached) {
          // Its own lookup, or the one that brought every crate at once.
          const found = r.lookup ?? this.lookups.deps;
          r.outcome = found?.outcome === 'r2' ? 'r2' : 'hit';
          r.start = found?.start ?? t;
          r.end = found?.end ?? t;
          r.segs = [{ cls: r.outcome, start: r.start, end: r.end }];
        }
        if (e.ok === false) r.segs.push({ cls: 'bad', start: t, end: t });
        break;
      }
      case 'work': {
        const r = this.unitRow(e.id);
        if (r.start == null) r.start = t;
        if (e.state === 'start') r.segs.push({ cls: e.worker === 'crates.io' ? 'crates' : e.worker, what: e.what, start: t });
        else {
          const seg = [...r.segs].reverse().find((s) => s.what === e.what && s.end == null);
          if (seg) { seg.end = t; if (!e.ok) seg.cls = 'bad'; }
        }
        break;
      }
      case 'result': this.result = e.result; this.finish(t); break;
      case 'error': this.error = e.message; this.finish(t); break;
    }
  }
  unitRow(id) { const { name, version } = crateOf(id); return this.row(id, { kind: 'unit', label: name, version }); }
  finish(t) { this.done = true; this.last = Math.max(this.last, t); }
  units() { return this.order.map((k) => this.rows.get(k)).filter((r) => r.kind === 'unit'); }
}
