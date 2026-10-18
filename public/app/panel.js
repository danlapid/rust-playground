// The panel: each Worker is a station on the playground Worker's line, with a lamp. Amber
// is work in progress; green, a Workers Cache hit; white, an answer from R2 or a finished
// job; red, a miss or a failure. Requests travel the track as trains.
import { $, el, ms, reduceMotion } from './dom.js';
import { crateOf } from './run.js';

export const panel = (() => {
  const line = $('line');
  const trains = $('trains');
  const stn = (name) => line.querySelector(`[data-stn="${name}"]`);
  const lamps = new Map();
  const jobs = new Map(); // station -> Map(key -> label)
  let describerItems = [];

  function lamp(name, color, hold = 0) {
    const s = stn(name);
    clearTimeout(lamps.get(name));
    s.dataset.lamp = color;
    if (hold) lamps.set(name, setTimeout(() => { if (!busy(name)) delete s.dataset.lamp; }, hold));
  }
  const busy = (name) => (jobs.get(name)?.size ?? 0) > 0;
  function settle(name, color = 'white') {
    if (busy(name)) lamp(name, 'amber');
    else lamp(name, color, 700);
  }
  function setJobs(name) {
    const s = stn(name);
    const plates = s.querySelector('.plates');
    if (!plates) return;
    const list = [...(jobs.get(name)?.values() ?? [])];
    const shown = list.slice(0, 6).map(({ label, what }) => {
      const p = el('span', 'plate', label);
      if (what) p.prepend(el('span', '', what));
      p.title = what ? `${what}: ${label}` : label;
      return p;
    });
    if (list.length > 6) shown.push(el('span', 'plate more', `${list.length - 6} more`));
    plates.replaceChildren(...shown);
  }
  function start(name, key, label, what) {
    if (!jobs.has(name)) jobs.set(name, new Map());
    jobs.get(name).set(key, { label, what });
    setJobs(name);
    lamp(name, 'amber');
  }
  function end(name, key, ok = true) {
    jobs.get(name)?.delete(key);
    setJobs(name);
    if (!ok) lamp(name, 'red', 2400);
    else settle(name);
  }
  function doing(name, text) { const d = stn(name).querySelector('.doing'); if (d) d.textContent = text ?? ''; }

  // A train along the track: down the trunk from one station, out to another.
  function anchor(name) {
    const s = stn(name);
    const box = trains.getBoundingClientRect();
    const l = s.querySelector('.lamp').getBoundingClientRect();
    return { x: l.left - box.left + l.width / 2, y: l.top - box.top + l.height / 2, branch: s.classList.contains('branch') };
  }
  function train(from, to, color = 'white', { back = false } = {}) {
    if (reduceMotion.matches || document.hidden) return;
    const a = anchor(from), b = anchor(to);
    const trunk = anchor('playground').x;
    const pts = [[a.x, a.y], [a.branch ? a.x - 26 : trunk, a.y], [b.branch ? b.x - 26 : trunk, b.y], [b.x, b.y]];
    if (back) pts.reverse();
    const dot = el('i', `train ${color}`);
    trains.append(dot);
    const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const total = lens.reduce((x, y) => x + y, 0) || 1;
    let acc = 0;
    const frames = pts.map((p, i) => { if (i) acc += lens[i - 1]; return { transform: `translate(${p[0]}px, ${p[1]}px)`, offset: acc / total }; });
    dot.animate(frames, { duration: Math.min(520, 160 + total * 0.9), easing: 'cubic-bezier(.4,.1,.3,1)' }).finished.then(() => dot.remove(), () => dot.remove());
  }

  function describe(at, text, kind) {
    describerItems.unshift({ at, text, kind });
    describerItems = describerItems.slice(0, 5);
    $('describer').replaceChildren(...describerItems.map(({ at, text, kind }) => {
      const li = el('li');
      const w = el('span', 'what', text);
      w.prepend(el('span', `dot ${kind ?? ''}`));
      li.append(el('span', 'at', at == null ? '' : ms(at)), w);
      return li;
    }));
  }

  const tallyNode = $('tally');
  const lookups = $('lookups');
  function showTally(t) {
    const k = (cls, n, word) => { const s = el('span', `k ${cls}`); s.append(el('b', '', String(n)), ` ${word}`); return s; };
    tallyNode.replaceChildren(k('hit', t.hit, t.hit === 1 ? 'hit' : 'hits'), k('r2', t.r2, 'from R2'), k('miss', t.miss, t.miss === 1 ? 'miss' : 'misses'));
  }
  function lookup(outcome, label) {
    const i = el('i', outcome);
    i.title = `${label}: ${OUTCOME_WORDS[outcome]}`;
    lookups.append(i);
    while (lookups.children.length > 40) lookups.firstElementChild.remove();
  }

  function reset() {
    for (const s of line.querySelectorAll('.stn')) delete s.dataset.lamp;
    for (const [, t] of lamps) clearTimeout(t);
    lamps.clear();
    jobs.clear();
    for (const p of line.querySelectorAll('.plates')) p.replaceChildren();
    for (const d of line.querySelectorAll('.doing')) d.textContent = '';
    lookups.replaceChildren();
    showTally({ hit: 0, r2: 0, miss: 0 });
    describerItems = [];
    $('describer').replaceChildren();
    trains.replaceChildren();
  }
  return { lamp, settle, start, end, doing, train, describe, showTally, lookup, reset };
})();

const OUTCOME_WORDS = { hit: 'Workers Cache hit', r2: 'from R2', miss: 'not cached' };
/** What a job is called on its station, by what the Worker is doing. */
const JOB_LABELS = { download: 'download', 'run the build script': 'build script', 'compile the build script': 'build script', 'compile the proc-macro module': 'macro module' };
const LOOKUP_LABELS = { resolve: 'Resolved versions', deps: 'All the dependencies', build: 'The snippet’s build' };

/** Shows an event on the panel: lamps, jobs, trains, the describer. */
export function showEvent(run, e) {
  const at = e.t;
  switch (e.type) {
    case 'step': {
      const cached = e.cached;
      if (e.step === 'resolve') {
        if (e.state === 'start') { panel.start('playground', 'resolve', 'versions', 'resolve'); panel.doing('playground', 'Resolving versions'); }
        else { panel.end('playground', 'resolve', e.ok); panel.doing('playground', ''); }
      } else if (e.step === 'deps') {
        if (e.state === 'start') { panel.start('playground', 'deps', 'dependencies', 'plan'); panel.doing('playground', 'Planning the dependencies'); }
        else { panel.end('playground', 'deps', e.ok); panel.doing('playground', ''); if (!e.ok) panel.describe(at, 'A dependency didn’t build', 'bad'); }
      } else if (e.step === 'compile' || e.step === 'link') {
        const station = e.step === 'compile' ? 'compiler' : 'linker';
        if (cached) {
          const outcome = run.lookups.build?.outcome ?? 'hit';
          if (e.step === 'compile' && e.state === 'end') panel.describe(at, `Built this way before, so its ${run.check ? 'result' : 'program'} comes ${outcome === 'hit' ? 'from Workers Cache' : 'from R2'}`, outcome);
          break;
        }
        if (e.state === 'start') {
          panel.train('playground', station, 'amber');
          panel.start(station, 'snippet', 'your snippet', e.step === 'compile' ? (run.check ? 'check' : 'compile') : 'link');
          panel.describe(at, e.step === 'compile' ? (run.check ? 'Checking the snippet' : 'Compiling the snippet') : 'Linking the program', 'work');
        } else {
          panel.end(station, 'snippet', e.ok);
          panel.train(station, 'playground', e.ok ? 'white' : 'red');
          const r = run.rows.get(e.step);
          panel.describe(at, `${e.step === 'compile' ? (run.check ? 'Checked' : 'Compiled') : 'Linked'} ${e.ok ? 'in' : 'with errors after'} ${ms((r?.end ?? at) - (r?.start ?? at))}`, e.ok ? 'done' : 'bad');
        }
      } else if (e.step === 'run') {
        if (e.state === 'start') { panel.train('playground', 'dynamic', 'amber'); panel.start('dynamic', 'program', 'your program', 'run'); }
        else { panel.end('dynamic', 'program', true); }
      }
      break;
    }
    case 'cache': {
      const label = e.id ? crateOf(e.id).name : LOOKUP_LABELS[e.what];
      panel.lookup(e.outcome, label);
      panel.showTally(run.tally);
      panel.train('playground', 'cache', 'white');
      if (e.outcome === 'hit') { panel.lamp('cache', 'green', 600); setTimeout(() => panel.train('cache', 'playground', 'green'), 120); }
      else if (e.outcome === 'r2') { panel.lamp('cache', 'white', 500); panel.lamp('r2', 'white', 700); setTimeout(() => panel.train('r2', 'playground', 'white'), 160); }
      else { panel.lamp('cache', 'red', 700); }
      // Crates come in dozens: describe the misses, and the lookups that stand for a whole step.
      if (e.what !== 'unit' || e.outcome === 'miss') {
        const how = e.outcome === 'miss' ? (e.what === 'unit' ? 'not cached, so it’s built' : e.what === 'build' ? 'not cached, so it’s compiled' : e.what === 'deps' ? 'not cached together, so each crate is looked up' : 'resolved from the index') : `${OUTCOME_WORDS[e.outcome]}, ${ms(e.ms)}`;
        panel.describe(at, `${label}: ${how}`, e.outcome);
      }
      break;
    }
    case 'unit': {
      if (e.state === 'end' && !e.cached && e.ok) panel.describe(at, `${crateOf(e.id).name} is built`, 'done');
      if (e.state === 'end' && e.ok === false) panel.describe(at, `${crateOf(e.id).name} didn’t build`, 'bad');
      break;
    }
    case 'work': {
      const name = crateOf(e.id).name;
      const station = e.worker === 'crates.io' ? 'crates' : e.worker;
      const key = `${e.id} ${e.what}`;
      const what = JOB_LABELS[e.what] ?? (e.what.startsWith('rustc ') ? e.what.slice(0, 24) : 'library');
      if (e.state === 'start') {
        panel.train('playground', station, 'amber');
        panel.start(station, key, name, what);
        if (e.what === 'compile the library') panel.describe(at, `${name}: compiling`, 'work');
        if (e.what === 'compile the build script') panel.describe(at, `${name}: compiling its build script`, 'work');
        if (e.what === 'compile the proc-macro module') panel.describe(at, `${name}: compiling the macro into a module of its own`, 'work');
        if (e.what === 'run the build script') panel.describe(at, `${name}: running its build script`, 'work');
        if (e.what.startsWith('rustc ')) panel.describe(at, `${name}’s build script runs ${e.what.slice(0, 40)}`, 'work');
      } else {
        panel.end(station, key, e.ok);
      }
      break;
    }
    case 'result': case 'error': break;
  }
}
