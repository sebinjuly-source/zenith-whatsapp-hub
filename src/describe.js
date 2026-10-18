/** Human-readable descriptions shared by the dashboard API and MCP. */
export const HISTORY_MODES = {
  full: 'Full chat history',
  recent: 'Recent history only (about the last few months)',
  none: 'No history — new messages only',
};

/** Summarise a number's settings change for the activity log, e.g. "AI sending: approve → auto". */
export function describeSettingsChange(before = {}, after = {}) {
  const label = {
    aiMode: 'AI sending', delayMinSec: 'Delay min (s)', delayMaxSec: 'Delay max (s)', typing: 'Typing indicator',
    dailyCap: 'Daily limit', sendStart: 'Send from', sendEnd: 'Send until', sendDays: 'Send days', storeGroups: 'Store groups',
    autosaveImages: 'Auto-save images', autosaveDocuments: 'Auto-save documents', autosaveKnownOnly: 'Auto-save only known',
    autosaveMaxMb: 'Auto-save max MB', optOutWords: 'Opt-out words', webhookUrl: 'Notify URL', historyMode: 'History on link',
  };
  const fmt = (v) => (Array.isArray(v) ? v.join(',') : v === '' ? '(none)' : String(v));
  return Object.keys(label)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `${label[k]}: ${fmt(before[k])} → ${fmt(after[k])}`)
    .join('; ');
}
