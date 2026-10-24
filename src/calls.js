/**
 * One-tap call results from a Board card. The owner calls a candidate from the card (tap the number), then taps
 * what happened; the hub does the bookkeeping that used to need typing:
 *   interested     → note, stage "interested", an AI card "send them the details / ask the day and time"
 *   date           → note, interview date (Interview card for the owner; the hub reminds them)
 *   no_answer      → note, an AI card "short WhatsApp: tried calling, when can we talk?" (3rd try says so)
 *   call_back      → note, an owner card "Call X again" at the time they asked for
 *   not_interested → note, stage not_interested (automatic messages to them are cancelled; nothing more is sent)
 * The card itself is closed — what happens next is on the new card (or on the Interview card).
 */
import { query } from './db.js';
import { toJid } from './store.js';
import { localDate, PHONE_RE } from './util.js';
import config from './config.js';
import { addNote, createTask, updateTask, logTask } from './tasks.js';

export const CALL_RESULTS = ['interested', 'date', 'no_answer', 'call_back', 'not_interested'];
const LABEL = { interested: 'answered — interested', date: 'answered — interview date fixed', no_answer: 'no answer', call_back: 'asked to be called back', not_interested: 'answered — not interested' };
const when = (d) => new Date(d).toLocaleString('en-IN', { timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** The person a card is about: its ref (hub cards), else the first phone number in its title/details/notes. */
export async function personOfCard(t) {
  const [kind, a, b] = String(t.ref || '').split(':');
  if (['reply', 'remind', 'visit', 'followup'].includes(kind) && b?.endsWith('@s.whatsapp.net')) {
    return { jid: b, account: kind === 'reply' || kind === 'remind' ? a : t.account_id, listId: ['visit', 'followup'].includes(kind) ? Number(a) : null };
  }
  const [n] = await query(`SELECT text FROM task_log WHERE task_id = $1 AND kind = 'note' ORDER BY id DESC LIMIT 1`, [t.id]);
  const text = `${t.title} ${t.details || ''} ${n?.text || ''}`;
  for (const m of text.matchAll(PHONE_RE)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 13) return { jid: toJid(d), account: t.account_id, listId: null };
  }
  return null;
}

/** The person's latest list membership (this number's lists first), or null. */
async function membership(jid, account, listId) {
  const [m] = await query(
    `SELECT m.list_id, m.name, l.name AS list_name FROM list_members m JOIN lists l ON l.id = m.list_id
     WHERE m.jid = $1 AND ($3::bigint IS NULL OR m.list_id = $3) ORDER BY (l.account_id = $2) DESC, l.id DESC LIMIT 1`,
    [jid, account, listId || null],
  );
  return m || null;
}

/**
 * Record a call result for card taskId. at = "YYYY-MM-DD HH:MM" (owner's time) for date / call_back.
 * Returns { note, card } — card = the follow-on card (AI / owner), if one was made.
 */
export async function recordCallResult(taskId, { result, at, note = '' } = {}) {
  if (!CALL_RESULTS.includes(result)) throw new Error(`Result must be one of: ${CALL_RESULTS.join(', ')}`);
  const [t] = await query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (!t) throw new Error('Card not found');
  const p = await personOfCard(t);
  if (!p) throw new Error('No phone number on this card — write the call notes as a note instead');
  const atDate = at ? localDate(at) : null;
  if ((result === 'date' || result === 'call_back') && (!atDate || isNaN(atDate))) throw new Error('Choose the date and time');
  const m = await membership(p.jid, p.account, p.listId);
  const name = m?.name || t.title.replace(/^(Call|Reply to|Follow up:|Interview:)\s*/i, '').split(/[–—:(]/)[0].trim() || p.jid.split('@')[0];
  const phone = p.jid.split('@')[0];
  const lists = await import('./lists.js');
  const extra = String(note || '').trim();
  let card = null;
  if (result === 'interested') {
    if (m) await lists.updateMember(m.list_id, p.jid, { stage: 'interested' });
    card = await createTask({ account: p.account, assignee: 'ai', dueAt: new Date().toISOString(), createdBy: 'you',
      title: `Owner called ${name}: interested — send the details`,
      details: `Owner spoke to ${name} (+${phone}) by phone: interested.${extra ? ` Owner's note: ${extra}.` : ''} Send a short WhatsApp on the number that has their chat: thanks for the call, location link, and ask the day and time they can come (then set visit_at).` });
  } else if (result === 'date') {
    if (m) await lists.updateMember(m.list_id, p.jid, { visitAt: atDate.toISOString() });
    else card = await createTask({ account: p.account, assignee: 'you', priority: true, dueAt: atDate.toISOString(), createdBy: 'you', title: `Interview: ${name} — ${when(atDate)}`, details: `+${phone}. Fixed on a call.${extra ? ` ${extra}` : ''}` });
  } else if (result === 'no_answer') {
    const [{ n }] = await query(`SELECT count(*)::int n FROM task_log l JOIN tasks x ON x.id = l.task_id WHERE l.kind = 'note' AND l.text LIKE '📞 Call: no answer%' AND (x.title LIKE $1 OR x.details LIKE $1 OR x.ref LIKE $2)`, [`%${phone.slice(-10)}%`, `%${p.jid}`]);
    card = await createTask({ account: p.account, assignee: 'ai', dueAt: new Date().toISOString(), createdBy: 'you',
      title: `Owner called ${name}: no answer${n >= 2 ? ` (${n + 1}th try)` : ''} — message them`,
      details: `Owner called ${name} (+${phone}) and got no answer${n >= 2 ? ` — that is the ${n + 1}th unanswered call` : ''}.${extra ? ` Owner's note: ${extra}.` : ''} Send a short WhatsApp on the number that has their chat: we tried calling, when is a good time to talk (or the day and time they can come).` });
  } else if (result === 'call_back') {
    card = await createTask({ account: p.account, assignee: 'you', priority: true, dueAt: atDate.toISOString(), createdBy: 'you',
      title: `Call ${name} again ${phone}`, details: `They asked to be called back at ${when(atDate)}.${extra ? ` ${extra}` : ''}` });
  } else if (result === 'not_interested') {
    if (m) await lists.updateMember(m.list_id, p.jid, { stage: 'not_interested', outcome: extra || 'not interested (call)' });
  }
  const text = `📞 Call: ${LABEL[result]}${atDate ? ` — ${when(atDate)}` : ''}${extra ? ` — ${extra}` : ''}${card ? ` → card #${card.id}` : ''}`;
  await addNote(t.id, text, 'you');
  // the result is fully handled here (or by the new card): not an open "owner note to act on" for the AI
  await logTask(t.id, card ? `Handed on as card #${card.id}` : 'Handled by the call result', { actor: 'ai' });
  if (!['done', 'cancelled'].includes(t.status)) await updateTask(t.id, { status: 'done', actor: 'you' });
  return { note: text, card, person: { name, phone, list: m?.list_name || null } };
}
