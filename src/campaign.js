/**
 * Campaigns keep concurrent work apart (Chef hiring, Front office, Housekeeping, later guest offers…).
 * A campaign is a job role: lists carry it, and everything else is tagged from the person's list —
 * outbox.role (stored on every message), tasks.role, events.role. Chats belong to the campaign of the latest list
 * the person is on (this number's lists first). "none" = not on any list (hotel guests, personal chats).
 */
export const NONE = 'none';

/** SQL: the campaign of chat <jidSql> on number <accSql> (null if they are on no list). */
export const roleOf = (accSql, jidSql) =>
  `(SELECT l.role FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.jid = ${jidSql} ORDER BY (l.account_id = ${accSql}) DESC, l.id DESC LIMIT 1)`;

/** SQL condition: expression <roleSql> matches the campaign filter at placeholder $<n> ('none' = no campaign). */
export const roleFilter = (roleSql, n) => `(CASE WHEN lower($${n}) = '${NONE}' THEN ${roleSql} IS NULL ELSE lower(${roleSql}) = lower($${n}) END)`;
