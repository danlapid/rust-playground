// rustc's diagnostics, for the editor's markers and the problems list.

/** The errors and warnings in rustc's output, with where in main.rs each one points. */
export function parseProblems(text) {
  const problems = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(error|warning)(?:\[(\w+)\])?: (.*)$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const loc = /^\s*--> \/work\/main\.rs:(\d+):(\d+)/.exec(lines[j]);
      if (!loc) { if (/^(error|warning)/.test(lines[j])) break; continue; }
      // The primary span: the run of ^ under the source line, at the reported column.
      const col = +loc[2];
      let len = 0, label = '';
      for (let k = j + 1; k < Math.min(j + 14, lines.length) && !/^(error|warning)/.test(lines[k]); k++) {
        const a = /^\s*\| (.*)$/.exec(lines[k]);
        const run = a && /^\^+/.exec(a[1].slice(col - 1));
        if (run) { len = run[0].length; label = a[1].slice(col - 1 + len).trim(); break; }
      }
      problems.push({ severity: m[1], code: m[2], message: m[3], line: +loc[1], col, len, label });
      break;
    }
  }
  return problems;
}
