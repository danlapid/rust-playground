// `cfg(...)` expressions in `[target.'cfg(...)'.dependencies]`, evaluated for the target.

export const TARGET = 'wasm32-unknown-emscripten';

/** `rustc --print cfg --target wasm32-unknown-emscripten`, without debug_assertions. */
export const TARGET_CFG: [string, string | null][] = [
  ['panic', 'unwind'],
  ['target_abi', ''],
  ['target_arch', 'wasm32'],
  ['target_endian', 'little'],
  ['target_env', ''],
  ['target_family', 'unix'],
  ['target_family', 'wasm'],
  ...['bulk-memory', 'crt-static', 'multivalue', 'mutable-globals', 'nontrapping-fptoint', 'reference-types', 'sign-ext']
    .map((f): [string, string] => ['target_feature', f]),
  ...['16', '32', '64', '8', 'ptr'].map((n): [string, string] => ['target_has_atomic', n]),
  ['target_os', 'emscripten'],
  ['target_pointer_width', '32'],
  ['target_vendor', 'unknown'],
  ['unix', null],
];

const has = (name: string, value: string | null) =>
  TARGET_CFG.some(([n, v]) => n === name && v === value);

/** Whether a dependency's `target` (a triple or `cfg(...)`) applies to the target. */
export function targetMatches(target: string | null | undefined): boolean {
  if (!target) return true;
  const m = /^cfg\((.*)\)$/s.exec(target.trim());
  if (!m) return target.trim() === TARGET;
  const tokens = m[1].match(/"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|[(),=]/g) ?? [];
  let i = 0;
  const expr = (): boolean => {
    const ident = tokens[i++];
    if (tokens[i] === '(' && (ident === 'all' || ident === 'any' || ident === 'not')) {
      i++;
      const args: boolean[] = [];
      while (tokens[i] !== ')') {
        args.push(expr());
        if (tokens[i] === ',') i++;
      }
      i++;
      return ident === 'all' ? args.every(Boolean) : ident === 'any' ? args.some(Boolean) : !args[0];
    }
    if (tokens[i] === '=') {
      i++;
      return has(ident, tokens[i++].slice(1, -1));
    }
    return has(ident, null);
  };
  return expr();
}
