// The editor: Monaco (VS Code's editor), or a textarea until it loads, or if it can't.
import { $, el, store } from './dom.js';

const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
const SAVED = 'rp:code';

/**
 * An editor in #editor, starting with `value`. `run(check)` is for its Run shortcuts.
 * It starts as a textarea and becomes Monaco once that loads, keeping what was typed.
 */
export function createEditor(value, run) {
  let impl = textareaEditor(value);
  loadMonaco((monaco) => {
    const typed = impl.getValue();
    $('editor').replaceChildren();
    impl = monacoEditor(monaco, typed, run);
  });
  return {
    getValue: () => impl.getValue(),
    setValue: (v) => impl.setValue(v),
    setProblems: (problems) => impl.setProblems(problems),
    reveal: (problem) => impl.reveal(problem),
  };
}

/** What was in the editor last time, if anything. */
export const savedCode = () => store.get(SAVED);

function textareaEditor(value) {
  const ta = el('textarea');
  ta.spellcheck = false;
  ta.setAttribute('aria-label', 'Rust code');
  ta.value = value;
  ta.addEventListener('input', () => store.set(SAVED, ta.value));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  $('editor').replaceChildren(ta);
  return {
    getValue: () => ta.value,
    setValue: (v) => { ta.value = v; store.set(SAVED, v); },
    setProblems: () => {},
    reveal: () => ta.focus(),
  };
}

function monacoEditor(monaco, value, run) {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const ed = monaco.editor.create($('editor'), {
    value, language: 'rust', theme: dark.matches ? 'vs-dark' : 'vs',
    automaticLayout: true, fontFamily: '"Martian Mono", ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 21,
    minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 4, insertSpaces: true,
    padding: { top: 12 }, renderLineHighlight: 'gutter', ariaLabel: 'Rust code', overviewRulerBorder: false, hideCursorInOverviewRuler: true,
  });
  dark.addEventListener('change', (e) => monaco.editor.setTheme(e.matches ? 'vs-dark' : 'vs'));
  ed.onDidChangeModelContent(() => store.set(SAVED, ed.getValue()));
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run(false));
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => run(true));
  const model = ed.getModel();
  return {
    getValue: () => ed.getValue(),
    setValue: (v) => { ed.setValue(v); ed.setScrollTop(0); },
    setProblems(problems) {
      monaco.editor.setModelMarkers(model, 'rustc', problems.map((p) => {
        const line = Math.min(p.line, model.getLineCount());
        const word = model.getWordAtPosition({ lineNumber: line, column: p.col });
        const end = p.len ? p.col + p.len : word ? word.endColumn : p.col + 1;
        return {
          severity: p.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: p.label ? `${p.message}\n${p.label}` : p.message,
          code: p.code, source: 'rustc',
          startLineNumber: line, startColumn: p.col, endLineNumber: line, endColumn: end,
        };
      }));
    },
    reveal(p) { ed.revealLineInCenter(p.line); ed.setPosition({ lineNumber: p.line, column: p.col }); ed.focus(); },
  };
}

function loadMonaco(loaded) {
  window.MonacoEnvironment = {
    getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(
      `self.MonacoEnvironment = { baseUrl: '${MONACO}/' }; importScripts('${MONACO}/vs/base/worker/workerMain.js');`)}`,
  };
  const s = document.createElement('script');
  s.src = `${MONACO}/vs/loader.js`;
  s.onload = () => {
    window.require.config({ paths: { vs: `${MONACO}/vs` } });
    window.require(['vs/editor/editor.main'], async (monaco) => {
      // Monaco measures the font once; let Martian Mono arrive first.
      try { await document.fonts.load('12.5px "Martian Mono"'); } catch {}
      loaded(monaco);
    });
  };
  document.head.append(s);
}
