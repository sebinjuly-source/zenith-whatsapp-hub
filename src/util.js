/** "2026-01-31", ISO datetime, or unix seconds → unix seconds */
export function toTs(v) {
  if (v == null || v === '') return undefined;
  if (/^\d{9,11}$/.test(String(v))) return parseInt(v, 10);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}
