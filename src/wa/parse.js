/**
 * Turns raw Baileys messages into compact rows for the database.
 * Keeps only what is useful to read/search later (text, type, quoted text, shared contacts,
 * media metadata needed for on-demand download) — no thumbnails or protocol noise.
 */
import { normalizeMessageContent, getContentType, toNumber } from '@whiskeysockets/baileys';

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video',
};

/** Parse a vCard into { name, phones: ['9198…'] }. WhatsApp puts the number in waid= when known. */
export function parseVcard(vcard = '', displayName = '') {
  const phones = new Set();
  for (const line of vcard.split(/\r?\n/)) {
    if (!/^(item\d+\.)?TEL/i.test(line)) continue;
    const waid = line.match(/waid=(\d+)/i);
    if (waid) phones.add(waid[1]);
    else {
      const num = line.split(':').pop().replace(/\D/g, '');
      if (num.length >= 8) phones.add(num);
    }
  }
  const fn = vcard.match(/^FN:(.*)$/im);
  const org = vcard.match(/^ORG:(.*)$/im);
  return {
    name: (displayName || fn?.[1] || '').trim(),
    org: org?.[1]?.replace(/;+$/, '').trim() || undefined,
    phones: [...phones],
  };
}

function textOf(content) {
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.interactiveResponseMessage?.body?.text ||
    content.buttonsMessage?.contentText ||
    content.templateMessage?.hydratedTemplate?.hydratedContentText ||
    content.interactiveMessage?.body?.text ||
    ''
  );
}

function contextInfoOf(content, type) {
  return content?.[type]?.contextInfo || content?.extendedTextMessage?.contextInfo || null;
}

/**
 * Returns one of:
 *  { kind: 'message', row }               — store it
 *  { kind: 'reaction', targetId, emoji, from }
 *  { kind: 'edit', targetId, body }
 *  { kind: 'revoke', targetId }
 *  { kind: 'skip' }
 */
export function parseMessage(msg) {
  const content = normalizeMessageContent(msg.message);
  if (!content) return { kind: 'skip' };
  // WhatsApp's call-log field is spelt "callLogMesssage" (3 s), so Baileys' getContentType never finds it
  const type = getContentType(content) || (content.callLogMesssage ? 'callLogMesssage' : undefined);
  if (!type) return { kind: 'skip' };

  if (type === 'protocolMessage') {
    const p = content.protocolMessage;
    if (p?.type === 0 /* REVOKE */ && p.key?.id) return { kind: 'revoke', targetId: p.key.id };
    if (p?.type === 14 /* MESSAGE_EDIT */ && p.key?.id) {
      return { kind: 'edit', targetId: p.key.id, body: textOf(normalizeMessageContent(p.editedMessage)) };
    }
    return { kind: 'skip' };
  }
  if (type === 'reactionMessage') {
    const r = content.reactionMessage;
    return { kind: 'reaction', targetId: r?.key?.id, emoji: r?.text || '' };
  }
  if (
    [
      'senderKeyDistributionMessage',
      'messageContextInfo',
      'pollUpdateMessage',
      'keepInChatMessage',
      'encReactionMessage',
      'pinInChatMessage',
      'botInvokeMessage',
    ].includes(type)
  ) {
    return { kind: 'skip' };
  }

  let mtype = MEDIA_TYPES[type] || 'text';
  let body = textOf(content);
  let vcards = null;
  let media = null;

  if (type === 'contactMessage') {
    mtype = 'contact';
    vcards = [parseVcard(content.contactMessage.vcard, content.contactMessage.displayName)];
    body = `Shared contact: ${vcards.map((v) => `${v.name} ${v.phones.join(', ')}`).join('; ')}`;
  } else if (type === 'contactsArrayMessage') {
    mtype = 'contact';
    vcards = (content.contactsArrayMessage.contacts || []).map((c) => parseVcard(c.vcard, c.displayName));
    body = `Shared ${vcards.length} contacts: ${vcards.map((v) => `${v.name} ${v.phones.join(', ')}`).join('; ')}`;
  } else if (type === 'locationMessage' || type === 'liveLocationMessage') {
    mtype = 'location';
    const l = content[type];
    body = `Location: ${l.name ? l.name + ' ' : ''}${l.address ? l.address + ' ' : ''}(${l.degreesLatitude}, ${l.degreesLongitude})`;
  } else if (type === 'callLogMesssage' || type === 'callLogMessage') {
    // Call log synced to linked devices: outcome + duration (answered calls carry real conversation)
    mtype = 'call';
    const l = content[type] || {};
    const secs = Number(l.durationSecs || 0);
    const outcome = String(l.callOutcome ?? '').toUpperCase();
    const answered = secs > 0 || outcome === 'CONNECTED' || outcome === '0';
    const kind = l.isVideo ? 'video' : 'voice';
    body = answered
      ? `📞 ${kind[0].toUpperCase()}${kind.slice(1)} call — answered, ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
      : `📞 Missed ${kind} call`;
  } else if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3' || type === 'pollCreationMessageV2') {
    mtype = 'poll';
    const p = content[type];
    body = `Poll: ${p.name} — ${(p.options || []).map((o) => o.optionName).join(' / ')}`;
  } else if (MEDIA_TYPES[type]) {
    const m = content[type];
    // Keep only the fields needed to download the file later (no thumbnails).
    media = {
      kind: type,
      mimetype: m.mimetype || null,
      fileName: m.fileName || null,
      size: m.fileLength ? toNumber(m.fileLength) : null,
      seconds: m.seconds || null,
      url: m.url || null,
      directPath: m.directPath || null,
      mediaKey: m.mediaKey ? Buffer.from(m.mediaKey).toString('base64') : null,
      fileSha256: m.fileSha256 ? Buffer.from(m.fileSha256).toString('base64') : null,
      fileEncSha256: m.fileEncSha256 ? Buffer.from(m.fileEncSha256).toString('base64') : null,
      mediaKeyTimestamp: m.mediaKeyTimestamp ? toNumber(m.mediaKeyTimestamp) : null,
    };
    if (type === 'audioMessage' && m.ptt) mtype = 'voice';
    if (!body && m.fileName) body = m.fileName;
  } else if (!body && type !== 'conversation' && type !== 'extendedTextMessage') {
    // Something we don't model in detail (call logs, payments, etc.) — keep a marker, not the payload.
    mtype = type.replace(/Message$/, '');
  }

  const ctx = contextInfoOf(content, type);
  const quoted = ctx?.quotedMessage ? normalizeMessageContent(ctx.quotedMessage) : null;

  return {
    kind: 'message',
    row: {
      id: msg.key.id,
      fromMe: !!msg.key.fromMe,
      ts: msg.messageTimestamp ? toNumber(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
      type: mtype,
      body: body || null,
      quotedId: ctx?.stanzaId || null,
      quotedBody: quoted ? textOf(quoted).slice(0, 300) || `[${getContentType(quoted) || 'message'}]` : null,
      forwarded: !!ctx?.isForwarded,
      forwardScore: ctx?.forwardingScore || 0,
      media,
      vcards,
      status: msg.status ?? null,
      pushName: msg.pushName || null,
    },
  };
}

/** Rebuild a minimal WAMessage from stored media metadata so Baileys can download it. */
export function mediaMessageFromRow(row) {
  const m = row.media;
  const b = (s) => (s ? Buffer.from(s, 'base64') : undefined);
  return {
    key: { id: row.id, remoteJid: row.chat_jid, fromMe: row.from_me },
    message: {
      [m.kind]: {
        url: m.url,
        directPath: m.directPath,
        mediaKey: b(m.mediaKey),
        fileSha256: b(m.fileSha256),
        fileEncSha256: b(m.fileEncSha256),
        mimetype: m.mimetype,
        fileLength: m.size,
        fileName: m.fileName,
      },
    },
  };
}
