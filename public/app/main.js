// The playground page: runs the code in the editor through /api/run, and shows the run as it
// streams back, on the panel and the timeline. Until the first Run, it replays a recorded one.
import { createEditor, savedCode } from './editor.js';
import { parseProblems } from './diagnostics.js';
import { $, el, hasDeps, ms, plural, reduceMotion } from './dom.js';
import { panel, showEvent } from './panel.js';
import { Run } from './run.js';
import { summarize, timeline } from './timeline.js';
import { EXAMPLES } from '../examples.js';

const editor = createEditor(savedCode() ?? EXAMPLES[0].code, (check) => go(check));

// ---- Examples ----
const picker = $('example');
picker.append(el('option', '', 'Choose one'));
for (const [i, ex] of EXAMPLES.entries()) { const o = el('option', '', ex.name); o.value = i; picker.append(o); }
picker.onchange = () => {
  const ex = EXAMPLES[picker.value];
  if (!ex) return;
  editor.setValue(ex.code);
  $('stdin').value = ex.stdin ?? '';
  $('stdin-box').open = !!ex.stdin;
  editor.setProblems([]);
  picker.selectedIndex = 0;
};

// ---- Driving a run: the panel, the clock and the timeline, frame by frame ----
let current = null;
let frame = 0;
function tick() {
  frame = 0;
  if (!current) return;
  timeline.draw(current);
  $('clock').textContent = ms(current.now());
  if (!current.done) frame = requestAnimationFrame(tick);
}
function follow(run) {
  current = run;
  panel.reset();
  timeline.reset();
  $('clock').classList.add('on');
  $('panel-state').textContent = run.recorded ? `Replaying ${recording.label}` : run.check ? 'Checking' : 'Running';
  panel.lamp('browser', 'amber');
  panel.train('browser', 'playground', 'amber');
  panel.start('playground', 'run', 'run');
  $('timeline-title').textContent = run.recorded ? `${capitalize(recording.label)}, from nothing` : 'The latest run, to scale';
  $('timeline-summary').textContent = run.recorded ? `Replaying ${recording.label} of the ${recording.example}, with nothing cached.` : 'Happening now.';
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(tick);
}
function apply(run, e, arrivedAt) {
  run.add(e, arrivedAt);
  if (run === current) showEvent(run, e);
  if (run.done && run === current) finished(run);
}
function finished(run) {
  cancelAnimationFrame(frame);
  timeline.draw(run);
  $('clock').textContent = ms(run.now());
  $('clock').classList.remove('on');
  panel.end('playground', 'run', !run.error);
  panel.settle('browser');
  const r = run.result;
  const ok = r && (!r.deps || r.deps.ok) && r.compile.ok && (!r.link || r.link.ok);
  const state = run.error ? 'Didn’t finish' : !ok ? (r.stage === 'deps' ? 'A dependency didn’t build' : 'Didn’t compile') : run.recorded ? 'Replayed' : `Done in ${ms(run.total ?? run.now())}`;
  $('panel-state').textContent = state;
  if (r?.run) panel.describe(run.now(), `The program exited with code ${r.run.exitCode}`, r.run.exitCode === 0 ? 'done' : 'bad');
  else if (run.error) panel.describe(run.now(), 'The run didn’t finish', 'bad');
  $('timeline-summary').innerHTML = r ? summarize(run, run.recorded && `The ${recording.example}’s ${recording.label.replace(/^a /, '')}`) : 'The run didn’t finish.';
  if (!run.recorded) $('announce').textContent = state;
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- A recorded first build (scripts/record-run.mjs), replayed until the first Run ----
let recording = null;
let replaying = null;
function replay() {
  const run = new Run({ recorded: true });
  follow(run);
  const { events } = recording;
  if (reduceMotion.matches) {
    for (const e of events) run.add(e);
    run.offset = performance.now() - run.last;
    panel.showTally(run.tally);
    finished(run);
    current = run;
    return;
  }
  // Faster than it happened: a first build takes tens of seconds.
  const end = events.at(-1).t;
  const speed = Math.max(1, end / 7000);
  const start = performance.now();
  // The clock and the bars follow the scaled clock while replaying.
  run.now = () => (run.done ? run.last : Math.min((performance.now() - start) * speed, end));
  let i = 0;
  const step = () => {
    if (current !== run) return;
    const elapsed = (performance.now() - start) * speed;
    while (i < events.length && events[i].t <= elapsed) {
      const e = events[i++];
      run.add(e);
      showEvent(run, e);
    }
    run.last = Math.max(run.last, Math.min(elapsed, end));
    if (i >= events.length) { run.done = true; finished(run); return; }
    replaying = setTimeout(step, 30);
  };
  step();
}

// ---- Maximize: the playground fills the window ----
function maximize(on) {
  const bench = document.querySelector('.bench');
  bench.classList.toggle('max', on);
  document.body.classList.toggle('maxed', on);
  $('max').textContent = on ? 'Restore' : 'Maximize';
  $('max').setAttribute('aria-pressed', String(on));
}
$('max').onclick = () => maximize(!document.querySelector('.bench').classList.contains('max'));
document.addEventListener('keydown', (e) => {
  // Esc inside the editor belongs to the editor (closing its widgets), unless nothing is open.
  if (e.key === 'Escape' && document.querySelector('.bench.max') && !document.querySelector('.monaco-editor .suggest-widget.visible, .monaco-editor .find-widget.visible')) maximize(false);
});

// ---- Running ----
let busy = false;
$('run').onclick = () => go(false);
$('check').onclick = () => go(true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(e.shiftKey); }
});

async function go(check) {
  if (busy) return;
  busy = true;
  clearTimeout(replaying);
  for (const b of [$('run'), $('check')]) b.disabled = true;
  const code = editor.getValue();
  editor.setProblems([]);
  $('out').replaceChildren(el('p', 'status', hasDeps(code)
    ? 'Building dependencies. A crate’s first build takes seconds; after that it comes from the cache. The panel shows each one.'
    : check ? 'Checking…' : 'Compiling…'));
  const run = new Run({ check });
  follow(run);
  const t0 = performance.now();
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ code, check, edition: $('edition').value, optLevel: $('opt').value, stdin: $('stdin').value }),
    });
    if (!res.ok) throw new Error(`The playground Worker answered ${res.status}: ${await res.text()}`);
    // One event per line.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === 'result') run.total = performance.now() - t0;
        apply(run, e, performance.now());
      }
    }
    if (run.error) throw new Error(run.error);
    if (!run.result) throw new Error('The stream ended before the run did.');
    render(run.result, check, run.total);
  } catch (e) {
    if (!run.done) { run.error = String(e.message ?? e); run.finish(run.now()); finished(run); }
    $('out').replaceChildren(el('p', 'status', 'The run didn’t complete. Press Run to try again.'), el('pre', 'stderr', String(e.message ?? e)));
  } finally {
    busy = false;
    for (const b of [$('run'), $('check')]) b.disabled = false;
  }
}

/** What the program printed, as the console shows it. */
function output(lines) {
  const pre = el('pre', 'stdout');
  for (const o of lines) pre.append(el('span', o.stream === 'stderr' ? 'stderr' : '', o.text + '\n'));
  return pre;
}

function render(r, check, total) {
  const out = [];
  const diag = [r.deps?.diagnostics, r.compile.diagnostics, r.link?.diagnostics].filter(Boolean).join('\n').trim();
  const problems = parseProblems(r.compile.diagnostics ?? '');
  editor.setProblems(problems);
  const ok = (!r.deps || r.deps.ok) && r.compile.ok && (!r.link || r.link.ok);

  const status = el('p', 'status');
  const errors = problems.filter((p) => p.severity === 'error').length;
  if (r.stage === 'deps') status.textContent = 'A dependency didn’t build. rustc’s output is below.';
  else if (!r.compile.ok) status.textContent = errors ? `rustc found ${plural(errors, 'error')}, marked in the editor. Select one to jump to it.` : 'rustc didn’t compile this. Its output is below.';
  else if (r.link && !r.link.ok) status.textContent = 'Linking failed. The linker’s output is below.';
  else if (check) status.textContent = problems.length ? `No errors, and ${plural(problems.length, 'warning')}.` : 'No errors.';
  else status.innerHTML = `Ran in <b>${ms(r.run.ms)}</b>${r.compile.cached ? ', built before, so it came from the cache' : ''}. The round trip took ${ms(total)}.`;
  out.push(status);

  if (problems.length) {
    const ul = el('ul', 'problems');
    for (const p of problems) {
      const li = el('li');
      const b = el('button');
      b.append(el('span', `sev-${p.severity}`, p.severity === 'error' ? 'Error' : 'Warning'), el('span', 'where', `${p.line}:${p.col}`),
        el('span', '', `${p.message}${p.code ? ` (${p.code})` : ''}`));
      b.onclick = () => editor.reveal(p);
      li.append(b);
      ul.append(li);
    }
    out.push(ul);
  }
  if (r.run) {
    const pre = output(r.run.output);
    if (!r.run.output.length) pre.append(el('span', 'hint', 'The program printed nothing.'));
    out.push(pre, el('p', r.run.exitCode === 0 ? 'exit' : 'exit bad', `Exited with code ${r.run.exitCode}.`));
  }
  if (diag) {
    const d = el('details', 'raw');
    d.open = !ok && !problems.length;
    d.append(el('summary', '', 'rustc output'), el('pre', ok ? '' : 'stderr', diag));
    out.push(d);
  }
  $('out').replaceChildren(...out);
}

// ---- Until the first Run: the recording replays, and the console shows what it printed ----
$('out').replaceChildren(el('p', 'status', 'Press Run, or Ctrl/⌘ + Enter. The Example menu has more to try.'));
panel.showTally({ hit: 0, r2: 0, miss: 0 });
fetch('recorded-run.json')
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
  .then((recorded) => {
    if (current) return; // Someone pressed Run first.
    const label = `a first ${recorded.optLevel === '2' ? 'release ' : ''}build`;
    recording = { ...recorded, label, example: `${recorded.example.replace(/^Crates: /, '')} example` };
    const nodes = [el('p', 'status', `Press Run, or Ctrl/⌘ + Enter. The panel is replaying ${label} of this example, with nothing cached; the Example menu has others.`)];
    const printed = recorded.events.at(-1)?.result?.run?.output;
    if (printed) nodes.push(output(printed));
    $('out').replaceChildren(...nodes);
    replay();
  })
  .catch(() => {}); // Without the recording, the panel waits for a Run.
