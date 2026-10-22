/**
 * Settings for all numbers. A number follows the shared default for every setting it hasn't changed itself:
 * when the defaults change, each number takes the new value only where it still had the old default — so the
 * Meta number keeps its own 250/day while the phones follow yours. Changing one number's setting makes it its own.
 * (historyMode is per number: it only matters when linking.)
 */
import { query } from './db.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';

export const SHARED_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'historyMode');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function getDefaults() {
  const [r] = await query(`SELECT value FROM config WHERE key = 'settingsDefaults'`);
  return normalizeSettings(r?.value || {});
}

/** Which settings a number has set itself (differ from the shared defaults). */
export function ownKeys(settings, defaults) {
  const s = normalizeSettings(settings);
  return SHARED_KEYS.filter((k) => !same(s[k], defaults[k]));
}

/** Save new defaults and pass them on to every number that still follows the old ones. */
export async function saveDefaults(input, manager) {
  const old = await getDefaults();
  const next = normalizeSettings({ ...old, ...input });
  await query(
    `INSERT INTO config (key, value) VALUES ('settingsDefaults', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
  const numbers = [];
  for (const a of manager.list()) {
    const cur = normalizeSettings(a.settings);
    const own = ownKeys(cur, old);
    const patch = {};
    for (const k of SHARED_KEYS) if (!own.includes(k) && !same(cur[k], next[k])) patch[k] = next[k];
    if (Object.keys(patch).length) await manager.update(a.id, { settings: patch });
    numbers.push({ id: a.id, label: a.label, own, changed: Object.keys(patch) });
  }
  return { defaults: next, numbers };
}

/** Put one number back on the defaults for every shared setting. */
export async function resetToDefaults(accountId, manager) {
  const d = await getDefaults();
  const patch = Object.fromEntries(SHARED_KEYS.map((k) => [k, d[k]]));
  return manager.update(accountId, { settings: patch });
}
