// src/engine/whatsapp.engine.js
// ✅ MOTOR PROFISSIONAL COMPLETO — WhatsApp Web Clone
import * as baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  proto,
  getContentType
} = baileys;

let sock = null;
let keepAliveInterval = null;

export function getSocket() { return sock; }

const status = {
  connection: "close",
  lastDisconnectCode: null,
  hasQr: false,
  qr: null,
  hasSocket: false,
  lastError: null
};

const chatsMap = new Map();
const messagesMap = new Map();
const contactsMap = new Map();
const presenceMap = new Map();
const messageStatusMap = new Map(); // msgId -> { delivered: [], read: [] }

// ─── Pasta de mídia ────────────────────────────────────────────
const MEDIA_DIR = process.env.MEDIA_DIR || "./media";
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
export const mediaDir = MEDIA_DIR;

// ─── Limpeza automática de mídia (7 dias, a cada 6h) ──────────
setInterval(() => {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(MEDIA_DIR);
    for (const file of files) {
      const fp = path.join(MEDIA_DIR, file);
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > maxAge) fs.unlinkSync(fp);
    }
  } catch {}
}, 6 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function safeJid(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (s.includes("@")) return s;
  const clean = s.replace(/\D/g, "");
  const finalNumber = clean.length === 13 && clean.startsWith("55")
    ? clean.slice(0, 4) + clean.slice(5) : clean;
  return `${finalNumber}@s.whatsapp.net`;
}

function extractText(msg) {
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    msg.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  );
}

function detectMediaType(msg) {
  const msgObj = msg.message || {};
  if (msgObj.imageMessage) return { type: "image", sub: msgObj.imageMessage, ext: ".jpg" };
  if (msgObj.videoMessage) return { type: "video", sub: msgObj.videoMessage, ext: ".mp4" };
  if (msgObj.audioMessage) return { type: "audio", sub: msgObj.audioMessage, ext: msgObj.audioMessage.ptt ? ".ogg" : ".mp3" };
  if (msgObj.stickerMessage) return { type: "sticker", sub: msgObj.stickerMessage, ext: ".webp" };
  if (msgObj.documentMessage) {
    const fname = msgObj.documentMessage.fileName || "file";
    const ext = path.extname(fname) || ".bin";
    return { type: "document", sub: msgObj.documentMessage, ext };
  }
  return null;
}

async function downloadAndSaveMedia(msg) {
  const mediaInfo = detectMediaType(msg);
  if (!mediaInfo) return null;
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const fileName = `${msg.key.id}${mediaInfo.ext}`;
    const filePath = path.join(MEDIA_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    return {
      type: mediaInfo.type,
      mediaUrl: `/media/${fileName}`,
      mimeType: mediaInfo.sub.mimetype || null,
      fileName: mediaInfo.sub.fileName || mediaInfo.sub.title || null,
      fileSize: mediaInfo.sub.fileLength || buffer.length,
      duration: mediaInfo.sub.seconds || null,
      caption: mediaInfo.sub.caption || null,
      width: mediaInfo.sub.width || null,
      height: mediaInfo.sub.height || null
    };
  } catch (err) {
    console.error("[media] Download failed:", msg.key.id, err.message);
    return {
      type: mediaInfo.type, mediaUrl: null,
      mimeType: mediaInfo.sub.mimetype || null,
      fileName: mediaInfo.sub.fileName || null,
      caption: mediaInfo.sub.caption || null,
      error: "download_failed"
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE STORE
// ═══════════════════════════════════════════════════════════════

async function upsertMessage(chatId, m) {
  const msgId = m.key?.id;
  if (!msgId) return;

  const arr = messagesMap.get(chatId) || [];
  if (arr.find(x => x.id === msgId)) return;

  let mediaData = null;
  if (detectMediaType(m)) mediaData = await downloadAndSaveMedia(m);

  // Detectar tipos especiais
  const msgObj = m.message || {};
  const contentType = getContentType ? getContentType(msgObj) : Object.keys(msgObj)[0];

  // Detectar reply/quote
  const contextInfo = msgObj[contentType]?.contextInfo || msgObj.extendedTextMessage?.contextInfo || null;
  const quotedId = contextInfo?.stanzaId || null;
  const quotedParticipant = contextInfo?.participant || null;
  const quotedText = contextInfo?.quotedMessage ? extractText(contextInfo.quotedMessage) : null;

  // Detectar reações
  const reactionMsg = msgObj.reactionMessage;

  // Detectar edição
  const editedMsg = msgObj.protocolMessage?.editedMessage;
  if (editedMsg) {
    const editId = msgObj.protocolMessage?.key?.id;
    if (editId) {
      const existing = arr.find(x => x.id === editId);
      if (existing) {
        existing.text = extractText(editedMsg);
        existing.edited = true;
        existing.editedAt = Math.floor(Date.now() / 1000);
      }
    }
    return;
  }

  // Detectar delete
  const deleteMsg = msgObj.protocolMessage?.type === 0; // REVOKE
  if (deleteMsg) {
    const delId = msgObj.protocolMessage?.key?.id;
    if (delId) {
      const existing = arr.find(x => x.id === delId);
      if (existing) {
        existing.deleted = true;
        existing.text = "";
        existing.mediaUrl = null;
      }
    }
    return;
  }

  // Detectar contato
  let contactData = null;
  if (msgObj.contactMessage) {
    contactData = {
      displayName: msgObj.contactMessage.displayName || "",
      vcard: msgObj.contactMessage.vcard || ""
    };
  }

  // Detectar localização
  let locationData = null;
  if (msgObj.locationMessage) {
    locationData = {
      latitude: msgObj.locationMessage.degreesLatitude,
      longitude: msgObj.locationMessage.degreesLongitude,
      name: msgObj.locationMessage.name || "",
      address: msgObj.locationMessage.address || ""
    };
  }

  // Detectar enquete
  let pollData = null;
  if (msgObj.pollCreationMessage || msgObj.pollCreationMessageV3) {
    const poll = msgObj.pollCreationMessage || msgObj.pollCreationMessageV3;
    pollData = {
      name: poll.name || "",
      options: (poll.options || []).map(o => o.optionName || ""),
      selectableCount: poll.selectableOptionsCount || 1
    };
  }

  // Se é reação, atualizar mensagem existente
  if (reactionMsg) {
    const targetId = reactionMsg.key?.id;
    const existing = arr.find(x => x.id === targetId);
    if (existing) {
      existing.reactions = existing.reactions || [];
      const emoji = reactionMsg.text;
      const sender = m.key.participant || m.key.remoteJid;
      if (emoji) {
        existing.reactions = existing.reactions.filter(r => r.sender !== sender);
        existing.reactions.push({ emoji, sender, timestamp: Date.now() });
      } else {
        existing.reactions = existing.reactions.filter(r => r.sender !== sender);
      }
    }
    return;
  }

  const msgType = mediaData?.type
    || (contactData ? "contact" : null)
    || (locationData ? "location" : null)
    || (pollData ? "poll" : null)
    || (contentType === "stickerMessage" ? "sticker" : null)
    || "text";

  const item = {
    id: msgId,
    fromMe: !!m.key?.fromMe,
    text: extractText(m.message) || mediaData?.caption || "",
    timestamp: Number(m.messageTimestamp || Date.now()),
    participant: m.key?.participant || null,
    pushName: m.pushName || null,
    type: msgType,
    // Mídia
    mediaUrl: mediaData?.mediaUrl || null,
    mimeType: mediaData?.mimeType || null,
    fileName: mediaData?.fileName || null,
    fileSize: mediaData?.fileSize || null,
    duration: mediaData?.duration || null,
    caption: mediaData?.caption || null,
    // Reply
    quotedId,
    quotedParticipant,
    quotedText,
    // Especiais
    contact: contactData,
    location: locationData,
    poll: pollData,
    // Status
    forwarded: !!contextInfo?.isForwarded,
    forwardingScore: contextInfo?.forwardingScore || 0,
    edited: false,
    deleted: false,
    reactions: [],
    // Efêmera
    ephemeral: !!contextInfo?.expiration,
    ephemeralDuration: contextInfo?.expiration || null,
    // Status de entrega
    status: m.key?.fromMe ? "sent" : "received"
  };

  arr.push(item);
  if (arr.length > 1000) arr.splice(0, arr.length - 1000);
  messagesMap.set(chatId, arr);

  // Atualizar chat index
  const existing = chatsMap.get(chatId) || { chatId, name: chatId };
  let preview = item.text;
  if (!preview && mediaData) {
    const icons = { image: "📷 Foto", video: "🎬 Vídeo", audio: "🎵 Áudio", document: "📎 Documento", sticker: "🖼️ Figurinha" };
    preview = icons[mediaData.type] || "Mídia";
  }
  if (!preview && contactData) preview = "👤 Contato";
  if (!preview && locationData) preview = "📍 Localização";
  if (!preview && pollData) preview = "📊 Enquete: " + pollData.name;

  chatsMap.set(chatId, {
    ...existing,
    chatId,
    lastMessage: preview || (item.fromMe ? "Mensagem enviada" : "Mensagem"),
    lastTimestamp: item.timestamp,
    unreadCount: item.fromMe ? (existing.unreadCount || 0) : (existing.unreadCount || 0) + 1
  });
}

function upsertChatFromHistory(chat) {
  const jid = chat.id;
  if (!jid || jid === "status@broadcast") return;
  const existing = chatsMap.get(jid) || {};
  const ts = Number(chat.conversationTimestamp || chat.muteExpiration || 0);
  chatsMap.set(jid, {
    chatId: jid,
    name: chat.name || chat.subject || existing.name || jid,
    lastMessage: existing.lastMessage || chat.lastMessage?.conversation || "",
    lastTimestamp: ts > (existing.lastTimestamp || 0) ? ts : (existing.lastTimestamp || ts),
    unreadCount: chat.unreadCount || existing.unreadCount || 0,
    pinned: chat.pinned || chat.pin || existing.pinned || false,
    archived: chat.archived || chat.archive || existing.archived || false,
    muted: chat.mute || chat.muteExpiration || existing.muted || false,
    ephemeral: chat.ephemeralExpiration || existing.ephemeral || null,
    ...existing
  });
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — STATUS & LEITURA
// ═══════════════════════════════════════════════════════════════

export function getWhatsAppStatus() {
  return { ...status, hasSocket: !!sock };
}

export function getQrString() { return status.qr; }

export function listChats() {
  const arr = Array.from(chatsMap.values());
  arr.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  return arr;
}

export function listMessages(chatId, limit = 50, beforeTs = null) {
  const arr = messagesMap.get(chatId) || [];
  let out = arr;
  if (beforeTs) {
    const ts = Number(beforeTs);
    out = out.filter(m => Number(m.timestamp) < ts);
  }
  out = [...out].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return out.slice(0, Math.max(1, Number(limit) || 50));
}

export function getPresence(chatId) {
  return presenceMap.get(chatId) || null;
}

export function getContact(chatId) {
  return contactsMap.get(chatId) || null;
}

export function getMessageStatus(messageId) {
  return messageStatusMap.get(messageId) || null;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — ENVIO
// ═══════════════════════════════════════════════════════════════

export async function sendText(chatIdOrNumber, text) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  const result = await sock.sendMessage(jid, { text: String(text || "") });
  await upsertMessage(jid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

export async function sendMedia(chatIdOrNumber, { type, buffer, mimetype, fileName, caption, ptt }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  let payload = {};
  switch (type) {
    case "image": payload = { image: buffer, mimetype: mimetype || "image/jpeg", caption: caption || "" }; break;
    case "video": payload = { video: buffer, mimetype: mimetype || "video/mp4", caption: caption || "" }; break;
    case "audio": payload = { audio: buffer, mimetype: mimetype || "audio/ogg; codecs=opus", ptt: ptt !== false }; break;
    case "document": payload = { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: fileName || "file", caption: caption || "" }; break;
    case "sticker": payload = { sticker: buffer, mimetype: mimetype || "image/webp" }; break;
    default: throw new Error("Tipo inválido");
  }
  const result = await sock.sendMessage(jid, payload);
  await upsertMessage(jid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

export async function sendReply(chatIdOrNumber, text, quotedMessageId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const msgs = messagesMap.get(jid) || [];
  const quoted = msgs.find(m => m.id === quotedMessageId);
  const result = await sock.sendMessage(jid, { text }, {
    quoted: { key: { remoteJid: jid, id: quotedMessageId, fromMe: quoted?.fromMe || false }, message: { conversation: quoted?.text || "" } }
  });
  await upsertMessage(jid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

export async function sendContact(chatIdOrNumber, { name, phone }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${phone.replace(/\D/g, "")}:${phone}\nEND:VCARD`;
  return await sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } });
}

export async function sendLocation(chatIdOrNumber, { latitude, longitude, name, address }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  return await sock.sendMessage(jid, { location: { degreesLatitude: latitude, degreesLongitude: longitude, name: name || "", address: address || "" } });
}

export async function sendPoll(chatIdOrNumber, { name, options, selectableCount }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  return await sock.sendMessage(jid, { poll: { name, values: options, selectableCount: selectableCount || 1 } });
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — AÇÕES EM MENSAGENS
// ═══════════════════════════════════════════════════════════════

export async function markAsRead(chatIdOrNumber, messageIds) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const keys = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(id => ({ remoteJid: jid, id }));
  await sock.readMessages(keys);
  // Reset unread
  const chat = chatsMap.get(jid);
  if (chat) { chat.unreadCount = 0; chatsMap.set(jid, chat); }
  return { ok: true };
}

export async function sendPresenceUpdate(chatIdOrNumber, type = "composing") {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  await sock.sendPresenceUpdate(type, jid);
  return { ok: true };
}

export async function sendReaction(chatIdOrNumber, messageId, emoji) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  return await sock.sendMessage(jid, { react: { text: emoji || "", key: { remoteJid: jid, id: messageId } } });
}

export async function deleteMessage(chatIdOrNumber, messageId, fromMe = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  return await sock.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe } });
}

export async function editMessage(chatIdOrNumber, messageId, newText) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  return await sock.sendMessage(jid, { text: newText, edit: { remoteJid: jid, id: messageId, fromMe: true } });
}

export async function forwardMessage(fromChatId, toChatIds, messageId) {
  if (!sock) throw new Error("Socket não inicializado");
  const fromJid = safeJid(fromChatId);
  const msgs = messagesMap.get(fromJid) || [];
  const original = msgs.find(m => m.id === messageId);
  if (!original) throw new Error("Mensagem não encontrada");

  const targets = Array.isArray(toChatIds) ? toChatIds : [toChatIds];
  const results = [];
  for (const to of targets) {
    const toJid = safeJid(to);
    const result = await sock.sendMessage(toJid, { text: original.text || "[Mídia encaminhada]" });
    await upsertMessage(toJid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
    results.push({ chatId: toJid, id: result?.key?.id });
  }
  return results;
}

export async function starMessage(chatIdOrNumber, messageIds, star = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const keys = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(id => ({ remoteJid: jid, id }));
  await sock.chatModify({ star: { messages: keys, star } }, jid);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — CONTATOS & PERFIL
// ═══════════════════════════════════════════════════════════════

export async function getProfilePicture(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  try { return { ok: true, url: await sock.profilePictureUrl(jid, "image") }; }
  catch { return { ok: true, url: null }; }
}

export async function getAbout(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  try { const r = await sock.fetchStatus(jid); return { ok: true, status: r?.status || null, setAt: r?.setAt || null }; }
  catch { return { ok: true, status: null }; }
}

export async function checkNumber(number) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(number);
  try { const [r] = await sock.onWhatsApp(jid.replace("@s.whatsapp.net", "")); return { ok: true, exists: !!r?.exists, jid: r?.jid || null }; }
  catch { return { ok: false, exists: false }; }
}

export async function blockContact(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.updateBlockStatus(safeJid(chatIdOrNumber), "block");
  return { ok: true };
}

export async function unblockContact(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.updateBlockStatus(safeJid(chatIdOrNumber), "unblock");
  return { ok: true };
}

export async function updateMyProfile({ name, about }) {
  if (!sock) throw new Error("Socket não inicializado");
  if (name) await sock.updateProfileName(name);
  if (about) await sock.updateProfileStatus(about);
  return { ok: true };
}

export async function updateMyProfilePicture(buffer) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.updateProfilePicture(sock.user?.id, buffer);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — GRUPOS
// ═══════════════════════════════════════════════════════════════

export async function getGroupMetadata(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = groupId.includes("@") ? groupId : groupId + "@g.us";
  return await sock.groupMetadata(jid);
}

export async function createGroup(name, participants) {
  if (!sock) throw new Error("Socket não inicializado");
  return await sock.groupCreate(name, participants.map(p => safeJid(p)).filter(Boolean));
}

export async function groupParticipants(groupId, participants, action) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const jids = participants.map(p => safeJid(p)).filter(Boolean);
  return await sock.groupParticipantsUpdate(jid, jids, action);
}

export async function getGroupInviteLink(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  const code = await sock.groupInviteCode(safeJid(groupId));
  return { ok: true, link: `https://chat.whatsapp.com/${code}` };
}

export async function revokeGroupInvite(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  const code = await sock.groupRevokeInvite(safeJid(groupId));
  return { ok: true, link: `https://chat.whatsapp.com/${code}` };
}

export async function updateGroupSubject(groupId, subject) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.groupUpdateSubject(safeJid(groupId), subject);
  return { ok: true };
}

export async function updateGroupDescription(groupId, description) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.groupUpdateDescription(safeJid(groupId), description);
  return { ok: true };
}

export async function updateGroupPicture(groupId, buffer) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.updateProfilePicture(safeJid(groupId), buffer);
  return { ok: true };
}

export async function setGroupSetting(groupId, setting) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.groupSettingUpdate(safeJid(groupId), setting);
  return { ok: true };
}

export async function leaveGroup(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.groupLeave(safeJid(groupId));
  return { ok: true };
}

export async function toggleGroupApproval(groupId, enabled) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  await sock.groupJoinApprovalMode(jid, enabled ? "on" : "off");
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — CHAT ACTIONS
// ═══════════════════════════════════════════════════════════════

export async function archiveChat(chatIdOrNumber, archive = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const chat = chatsMap.get(jid);
  const lastMsg = messagesMap.get(jid)?.[messagesMap.get(jid).length - 1];
  await sock.chatModify({ archive, lastMessages: [{ key: { remoteJid: jid, id: lastMsg?.id || "" }, messageTimestamp: lastMsg?.timestamp || Math.floor(Date.now() / 1000) }] }, jid);
  if (chat) { chat.archived = archive; chatsMap.set(jid, chat); }
  return { ok: true };
}

export async function pinChat(chatIdOrNumber, pin = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  await sock.chatModify({ pin }, jid);
  const chat = chatsMap.get(jid);
  if (chat) { chat.pinned = pin; chatsMap.set(jid, chat); }
  return { ok: true };
}

export async function muteChat(chatIdOrNumber, muteSeconds = null) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const mute = muteSeconds ? Date.now() + (muteSeconds * 1000) : null;
  await sock.chatModify({ mute }, jid);
  const chat = chatsMap.get(jid);
  if (chat) { chat.muted = !!mute; chatsMap.set(jid, chat); }
  return { ok: true };
}

export async function deleteChat(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  const lastMsg = messagesMap.get(jid)?.[messagesMap.get(jid).length - 1];
  await sock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: jid, id: lastMsg?.id || "" }, messageTimestamp: lastMsg?.timestamp || Math.floor(Date.now() / 1000) }] }, jid);
  chatsMap.delete(jid);
  messagesMap.delete(jid);
  return { ok: true };
}

export async function markUnread(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  await sock.chatModify({ markRead: false, lastMessages: [] }, jid);
  const chat = chatsMap.get(jid);
  if (chat) { chat.unreadCount = Math.max(1, chat.unreadCount || 1); chatsMap.set(jid, chat); }
  return { ok: true };
}

export async function setEphemeral(chatIdOrNumber, duration = 86400) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  await sock.sendMessage(jid, { disappearingMessagesInChat: duration });
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// INIT WHATSAPP
// ═══════════════════════════════════════════════════════════════

export async function initWhatsApp() {
  status.lastError = null;
  const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  status.connection = "connecting";
  status.hasSocket = true;

  sock = makeWASocket({ auth: state, version, printQRInTerminal: true });

  // Keep-alive
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(async () => {
    if (sock && status.connection === "open") {
      try { await sock.sendPresenceUpdate("available"); } catch {}
    }
  }, 25000);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { status.hasQr = true; status.qr = qr; }
    if (connection) status.connection = connection;
    const code = lastDisconnect?.error?.output?.statusCode ?? null;
    status.lastDisconnectCode = code;

    if (connection === "open") {
      status.hasQr = false; status.qr = null; status.lastError = null;
      console.log("[engine] WhatsApp conectado");
    }
    if (connection === "close") {
      console.log("[engine] Desconectou:", code || "");
      if (code === DisconnectReason.loggedOut) { status.lastError = "logged_out"; return; }
      setTimeout(() => initWhatsApp(), 1500);
    }
  });

  // Histórico completo
  sock.ev.on("messaging-history.set", async ({ chats, messages, isLatest }) => {
    console.log(`[history] ${chats?.length || 0} conversas, ${messages?.length || 0} msgs`);
    if (chats) for (const c of chats) upsertChatFromHistory(c);
    if (messages) for (const m of messages) {
      const cid = m.key?.remoteJid;
      if (cid && cid !== "status@broadcast") {
        try { await upsertMessage(cid, m); } catch (e) { console.error("[history]", e.message); }
      }
    }
  });

  sock.ev.on("chats.upsert", (cs) => { for (const c of cs) upsertChatFromHistory(c); });

  sock.ev.on("chats.update", (updates) => {
    for (const u of updates) {
      const jid = u.id; if (!jid) continue;
      const e = chatsMap.get(jid) || { chatId: jid, name: jid };
      if (u.unreadCount !== undefined) e.unreadCount = u.unreadCount;
      if (u.archived !== undefined) e.archived = u.archived;
      if (u.pinned !== undefined) e.pinned = u.pinned;
      if (u.conversationTimestamp) { const ts = Number(u.conversationTimestamp); if (ts > (e.lastTimestamp || 0)) e.lastTimestamp = ts; }
      chatsMap.set(jid, e);
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      const jid = c.id; if (!jid) continue;
      contactsMap.set(jid, { name: c.name || c.notify || null, phone: jid });
      const chat = chatsMap.get(jid);
      if (chat && !chat.name && (c.name || c.notify)) { chat.name = c.name || c.notify; chatsMap.set(jid, chat); }
    }
  });

  // Presença (online/digitando)
  sock.ev.on("presence.update", ({ id, presences }) => {
    presenceMap.set(id, { ...presences, updatedAt: Date.now() });
  });

  // Status de mensagem (entregue/lida)
  sock.ev.on("message-receipt.update", (updates) => {
    for (const { key, receipt } of updates) {
      const msgId = key.id;
      const existing = messageStatusMap.get(msgId) || { delivered: [], read: [] };
      if (receipt.receiptTimestamp) existing.delivered.push({ jid: receipt.userJid, at: receipt.receiptTimestamp });
      if (receipt.readTimestamp) existing.read.push({ jid: receipt.userJid, at: receipt.readTimestamp });
      messageStatusMap.set(msgId, existing);

      // Atualizar status no store
      const chatMsgs = messagesMap.get(key.remoteJid);
      if (chatMsgs) {
        const msg = chatMsgs.find(m => m.id === msgId);
        if (msg) {
          if (receipt.readTimestamp) msg.status = "read";
          else if (receipt.receiptTimestamp) msg.status = "delivered";
        }
      }
    }
  });

  // Mensagens em tempo real
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages || []) {
      const cid = m.key?.remoteJid;
      if (!cid) continue;
      await upsertMessage(cid, m);
    }
  });

  // Atualização de mensagens (edição, etc)
  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      const chatMsgs = messagesMap.get(key.remoteJid);
      if (!chatMsgs) continue;
      const msg = chatMsgs.find(m => m.id === key.id);
      if (!msg) continue;
      if (update.status) {
        const statusMap = { 2: "sent", 3: "delivered", 4: "read" };
        msg.status = statusMap[update.status] || msg.status;
      }
    }
  });

  return sock;
}

// ═══════════════════════════════════════════════════════════════
// RESTART
// ═══════════════════════════════════════════════════════════════

export async function restartSession() {
  try {
    if (sock) { try { await sock.logout(); } catch { try { sock.end(); } catch {} } }
    const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    status.connection = "close"; status.qr = null; status.hasQr = false;
    await initWhatsApp();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function logoutSession() {
  if (!sock) throw new Error("Socket não inicializado");
  await sock.logout();
  status.connection = "close"; status.lastError = "logged_out";
  return { ok: true };
}
