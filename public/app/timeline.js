// The timeline: the run to scale, a row per step and per crate, growing as it happens.
import { $, el, ms, plural } from './dom.js';

export const timeline = (() => {
  const chart = $('chart');
  let shape = null;
  let rowsDom = new Map();
  let axis;

  function ticks(span, max) {
    const pow = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(span, 1) / max)));
    const step = [1, 2, 5, 10, 20].map((m) => m * pow).find((s) => span / s <= max) ?? 20 * pow;
    const out = [];
    for (let v = 0; v <= span * 0.97; v += step) out.push(v);
    return out;
  }

  function layout(run) {
    const units = run.units();
    const steps = (k) => run.rows.get(k);
    const order = [];
    if (steps('resolve')) order.push({ group: 'Playground Worker', note: 'picks versions from the crates.io index' }, steps('resolve'));
    if (steps('deps')) order.push({ group: 'Compiler Worker and Dynamic Workers', note: `built before, so they come ${run.lookups.deps.outcome === 'hit' ? 'from Workers Cache' : 'from R2'} together` }, steps('deps'));
    else if (units.length) order.push({ group: 'Compiler Worker and Dynamic Workers', note: plural(units.length, 'crate') }, ...units);
    if (steps('compile')) order.push({ group: 'Compiler Worker', note: 'rustc.wasm' }, steps('compile'));
    if (steps('link')) order.push({ group: 'Linker Worker', note: 'wasm-ld.wasm' }, steps('link'));
    if (steps('run')) order.push({ group: 'Dynamic Worker', note: 'no network' }, steps('run'));
    return order;
  }

  function draw(run) {
    const order = layout(run);
    const key = order.map((o) => o.group ? `g:${o.group}:${o.note}` : `r:${o.key}`).join('|');
    if (key !== shape) {
      shape = key;
      rowsDom = new Map();
      const nodes = [];
      for (const o of order) {
        if (o.group) {
          const g = el('div', 'row group');
          const n = el('div', 'label', o.group);
          n.append(el('span', '', `, ${o.note}`));
          g.append(n);
          nodes.push(g);
          continue;
        }
        const d = el('div', 'row');
        const label = el('div', o.kind === 'step' ? 'label step' : 'label', o.label);
        if (o.version) label.append(el('span', 'ver', ` ${o.version}`));
        label.title = o.version ? `${o.label} ${o.version}` : o.label;
        const lane = el('div', 'lane');
        const t = el('div', 't');
        d.append(label, lane, t);
        rowsDom.set(o.key, { lane, t, segs: [] });
        nodes.push(d);
      }
      const axisRow = el('div', 'row axis-row');
      axis = el('div', 'axis');
      axisRow.append(el('div'), axis, el('div'));
      nodes.push(axisRow);
      chart.replaceChildren(...nodes);
    }
    const now = run.now();
    const span = Math.max(now, 1);
    for (const [k, dom] of rowsDom) {
      const r = run.rows.get(k);
      while (dom.segs.length < r.segs.length) { const s = el('div', 'seg'); dom.lane.append(s); dom.segs.push(s); }
      while (dom.segs.length > r.segs.length) dom.segs.pop().remove();
      r.segs.forEach((s, i) => {
        const end = s.end ?? now;
        const live = s.end == null && !run.done;
        const node = dom.segs[i];
        node.className = `seg ${s.cls}${live && s.cls !== 'span' ? ' live' : ''}`;
        node.style.left = `${(s.start / span) * 100}%`;
        node.style.width = `${(Math.max(0, end - s.start) / span) * 100}%`;
        node.title = s.what ?? '';
      });
      const dur = r.start == null ? null : (r.end ?? (run.done ? r.start : now)) - r.start;
      dom.t.textContent = dur == null ? '' : ms(dur);
    }
    const marks = ticks(span, chart.clientWidth < 600 ? 3 : 6);
    axis.replaceChildren(...marks.map((v) => { const s = el('span', '', v === 0 ? '0' : ms(v)); s.style.left = `${(v / span) * 100}%`; return s; }));
  }
  return { draw, reset() { shape = null; } };
})();

/** A sentence or two about a finished run; `recorded` describes a recording. */
export function summarize(run, recorded) {
  const r = run.result;
  const units = run.units();
  const built = units.filter((u) => u.cached === false);
  const scripts = built.filter((u) => u.buildScript).length;
  const parts = [];
  if (units.length) {
    parts.push(built.length
      ? `<b>${plural(built.length, 'crate')} compiled in Workers</b>${units.length > built.length ? ` (${units.length - built.length} more from the cache)` : ''}${scripts ? `, running ${plural(scripts, 'build script')} along the way` : ''}`
      : `<b>${run.rows.has('deps') ? `all ${plural(units.length, 'crate')} came ${run.lookups.deps.outcome === 'hit' ? 'from Workers Cache' : 'from R2'} in one lookup` : `${plural(units.length, 'crate')} came from the cache`}</b>`);
  }
  if (r && r.stage !== 'deps') {
    parts.push(r.compile.cached
      ? `the snippet ${run.check ? 'had been checked' : 'had been built'} the same way before, so ${run.check ? 'the result' : 'its program'} came ${run.lookups.build?.outcome === 'r2' ? 'from R2' : 'from Workers Cache'} in <b>${ms(r.compile.ms)}</b>`
      : `the snippet ${run.check ? 'was checked' : 'compiled'} in <b>${ms(r.compile.ms)}</b>`);
  }
  if (r?.link && !r.link.cached) parts.push(`it linked in ${ms(r.link.ms)}`);
  if (r?.run) parts.push(`it ran in <b>${ms(r.run.ms)}</b>`);
  const sentence = parts.join(', then ');
  if (run.recorded) return `${recorded}, recorded in wrangler dev with nothing cached: ${sentence}. In wrangler dev every Worker shares one machine, so it’s slower than deployed; and deployed, a few of these crates need more memory than a Worker gives rustc, so they’re built ahead of time.`;
  return `${sentence.replace(/^((?:<[^>]+>)*)(\w)/, (_, tags, c) => tags + c.toUpperCase())}.${run.total ? ` The round trip from the browser took ${ms(run.total)}.` : ''}`;
}
