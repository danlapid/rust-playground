// Small helpers for the page.

export const $ = (id) => document.getElementById(id);
export const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
export const ms = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
export const hasDeps = (code) => /^\s*---/.test(code.replace(/^#!(?!\[)[^\n]*\n/, ''));
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
