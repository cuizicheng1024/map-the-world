export function getQueryParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

export function setQueryParam(name, value) {
  const url = new URL(window.location.href);
  if (value === null || value === undefined || value === "") {
    url.searchParams.delete(name);
  } else {
    url.searchParams.set(name, value);
  }
  window.history.replaceState({}, "", url.toString());
}

export async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status}`);
  }
  return await res.json();
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function debounce(fn, waitMs) {
  let t = null;
  return (...args) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), waitMs);
  };
}

export function groupBy(items, keyFn) {
  const m = new Map();
  for (const item of items) {
    const k = keyFn(item);
    const arr = m.get(k) ?? [];
    arr.push(item);
    m.set(k, arr);
  }
  return m;
}

export function uniq(items) {
  return Array.from(new Set(items));
}

export function sortBy(items, keyFn) {
  return [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

