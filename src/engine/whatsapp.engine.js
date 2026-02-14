// ═══════════════════════════════════════════════════════════════
// whatsapp.engine.js — Motor WhatsApp Profissional Completo
// Caminho no Railway: src/engine/whatsapp.engine.js
// ═══════════════════════════════════════════════════════════════

import * as baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  proto
} = baileys;

let sock = null;

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
const presenceStore = {};
const receiptStore = {};
let updateLog = [];

const MEDIA_DIR = process.env.MEDIA_DIR || "./media";
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
export const mediaDir = MEDIA_DIR;

// ═══════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════

function safeJid(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (s.includes("@")) return s;
  const clean = s.replace(/\D/g, "");
  const finalNumber =
    clean.length === 13 && clean.startsWith("55")
      ? clean.slice(0, 4) + clean.slice(5)
      : clean;
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
    console.error("[media] Download failed for", msg.key.id, err.message);
    return {
      type: mediaInfo.type,
      mediaUrl: null,
      mimeType: mediaInfo.sub.mimetype || null,
      fileName: mediaInfo.sub.fileName || null,
      caption: mediaInfo.sub.caption || null,
      error: "download_failed"
    };
  }
}

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

setInterval(() => {
  const maxAge = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAge;
  updateLog = updateLog.filter(e => e.ts > cutoff);
}, 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// STORE DE MENSAGENS
// ═══════════════════════════════════════════════════════════════

async function upsertMessage(chatId, m) {
  const msgId = m.key?.id;
  if (!msgId) return;

  const arr = messagesMap.get(chatId) || [];
  const existingIdx = arr.findIndex(x => x.id === msgId);
  if (existingIdx >= 0) return;

  let mediaData = null;
  if (detectMediaType(m)) {
    mediaData = await downloadAndSaveMedia(m);
  }

  const contextInfo = m.message?.extendedTextMessage?.contextInfo ||
    m.message?.imageMessage?.contextInfo ||
    m.message?.videoMessage?.contextInfo ||
    m.message?.documentMessage?.contextInfo || null;

  const item = {
    id: msgId,
    fromMe: !!m.key?.fromMe,
    text: extractText(m.message) || mediaData?.caption || "",
    timestamp: Number(m.messageTimestamp || Date.now()),
    participant: m.key?.participant || null,
    pushName: m.pushName || null,
    type: mediaData?.type || "text",
    mediaUrl: mediaData?.mediaUrl || null,
    mimeType: mediaData?.mimeType || null,
    fileName: mediaData?.fileName || null,
    fileSize: mediaData?.fileSize || null,
    duration: mediaData?.duration || null,
    caption: mediaData?.caption || null,
    quotedId: contextInfo?.stanzaId || null,
    quotedParticipant: contextInfo?.participant || null,
    quotedText: contextInfo?.quotedMessage ? extractText(contextInfo.quotedMessage) : null,
    status: m.key?.fromMe ? "sent" : "received",
    reactions: [],
    isEdited: false,
    editedText: null,
    isRevoked: false,
    isForwarded: !!contextInfo?.isForwarded,
    forwardScore: contextInfo?.forwardingScore || 0,
    pollName: m.message?.pollCreationMessage?.name || null,
    pollOptions: m.message?.pollCreationMessage?.options?.map(o => o.optionName) || null,
  };

  arr.push(item);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  messagesMap.set(chatId, arr);

  const existing = chatsMap.get(chatId) || { chatId, name: chatId };
  let preview = item.text;
  if (!preview && mediaData) {
    const icons = { image: "📷 Foto", video: "🎬 Vídeo", audio: "🎵 Áudio", document: "📎 Documento", sticker: "🖼️ Figurinha" };
    preview = icons[mediaData.type] || "Mídia";
  }
  if (!preview && item.pollName) preview = `📊 ${item.pollName}`;

  chatsMap.set(chatId, {
    ...existing,
    chatId,
    lastMessage: preview || (item.fromMe ? "Mensagem enviada" : "Mensagem"),
    lastTimestamp: item.timestamp,
    name: existing.name || m.pushName || chatId
  });

  updateLog.push({ ts: Date.now(), type: "message", chatId, msgId });
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — LEITURA
// ═══════════════════════════════════════════════════════════════

export function getWhatsAppStatus() {
  return { ...status, hasSocket: !!sock };
}

export function getQrString() {
  return status.qr;
}

export function getSocket() {
  return sock;
}

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

export function getPresenceStore() {
  return presenceStore;
}

export function getReceiptStore() {
  return receiptStore;
}

export function getUpdates(since) {
  const sinceTs = Number(since) || 0;
  const events = updateLog.filter(e => e.ts > sinceTs);
  return { ok: true, events, serverTs: Date.now() };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — ENVIO DE MENSAGENS
// ═══════════════════════════════════════════════════════════════

export async function sendText(chatIdOrNumber, text) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  const payload = { text: String(text || "") };
  const result = await sock.sendMessage(jid, payload);
  await upsertMessage(jid, {
    key: { id: result?.key?.id, fromMe: true, remoteJid: jid },
    message: { conversation: payload.text },
    messageTimestamp: Math.floor(Date.now() / 1000)
  });
  return result;
}

export async function sendMedia(chatIdOrNumber, { type, buffer, mimetype, fileName, caption, ptt }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  let payload = {};
  switch (type) {
    case "image":
      payload = { image: buffer, mimetype: mimetype || "image/jpeg", caption: caption || "" };
      break;
    case "video":
      payload = { video: buffer, mimetype: mimetype || "video/mp4", caption: caption || "" };
      break;
    case "audio":
      payload = { audio: buffer, mimetype: mimetype || "audio/ogg; codecs=opus", ptt: ptt !== false };
      break;
    case "document":
      payload = { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: fileName || "file", caption: caption || "" };
      break;
    case "sticker":
      payload = { sticker: buffer, mimetype: mimetype || "image/webp" };
      break;
    default:
      throw new Error("Tipo inválido: image, video, audio, document, sticker");
  }

  const result = await sock.sendMessage(jid, payload);
  await upsertMessage(jid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

export async function sendReply(chatIdOrNumber, text, quotedMessageId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const msgs = messagesMap.get(jid) || [];
  const quoted = msgs.find(m => m.id === quotedMessageId);

  const result = await sock.sendMessage(jid, { text }, {
    quoted: {
      key: { remoteJid: jid, id: quotedMessageId, fromMe: quoted?.fromMe || false },
      message: { conversation: quoted?.text || "" }
    }
  });

  await upsertMessage(jid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

export async function sendPoll(chatIdOrNumber, name, options, multiSelect = false) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const result = await sock.sendMessage(jid, {
    poll: { name, values: options, selectableCount: multiSelect ? 0 : 1 }
  });
  await upsertMessage(jid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

export async function sendContact(chatIdOrNumber, { name, phone }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${phone.replace(/\D/g, "")}:${phone}\nEND:VCARD`;
  const result = await sock.sendMessage(jid, {
    contacts: { displayName: name, contacts: [{ vcard }] }
  });
  return result;
}

export async function sendLocation(chatIdOrNumber, { latitude, longitude, name, address }) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const result = await sock.sendMessage(jid, {
    location: { degreesLatitude: latitude, degreesLongitude: longitude, name: name || "", address: address || "" }
  });
  return result;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — AÇÕES DE MENSAGEM
// ═══════════════════════════════════════════════════════════════

export async function markAsRead(chatIdOrNumber, messageIds) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const keys = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(id => ({
    remoteJid: jid, id
  }));
  await sock.readMessages(keys);
  return { ok: true };
}

export async function sendReaction(chatIdOrNumber, messageId, emoji) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const result = await sock.sendMessage(jid, {
    react: { text: emoji || "", key: { remoteJid: jid, id: messageId } }
  });
  return result;
}

export async function deleteMessage(chatIdOrNumber, messageId, fromMe = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const result = await sock.sendMessage(jid, {
    delete: { remoteJid: jid, id: messageId, fromMe }
  });

  const msgs = messagesMap.get(jid) || [];
  const msg = msgs.find(m => m.id === messageId);
  if (msg) msg.isRevoked = true;

  return result;
}

export async function editMessage(chatIdOrNumber, messageId, newText) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");

  const result = await sock.sendMessage(jid, {
    text: newText,
    edit: { remoteJid: jid, id: messageId, fromMe: true }
  });

  const msgs = messagesMap.get(jid) || [];
  const msg = msgs.find(m => m.id === messageId);
  if (msg) {
    msg.isEdited = true;
    msg.editedText = newText;
    msg.text = newText;
  }

  return result;
}

export async function forwardMessage(fromChatId, toChatId, messageId) {
  if (!sock) throw new Error("Socket não inicializado");
  const fromJid = safeJid(fromChatId);
  const toJid = safeJid(toChatId);
  if (!fromJid || !toJid) throw new Error("chat_id inválido");

  const msgs = messagesMap.get(fromJid) || [];
  const original = msgs.find(m => m.id === messageId);
  if (!original) throw new Error("Mensagem não encontrada");

  const result = await sock.sendMessage(toJid, {
    text: original.text || "[Mídia encaminhada]",
    contextInfo: { isForwarded: true, forwardingScore: (original.forwardScore || 0) + 1 }
  });
  await upsertMessage(toJid, { key: result.key, message: result.message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return result;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — PRESENÇA
// ═══════════════════════════════════════════════════════════════

export async function sendPresence(chatIdOrNumber, type = "composing") {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  await sock.sendPresenceUpdate(type, jid);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — PERFIL E CONTATOS
// ═══════════════════════════════════════════════════════════════

export async function getProfilePicture(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  try {
    const url = await sock.profilePictureUrl(jid, "image");
    return { ok: true, url };
  } catch {
    return { ok: true, url: null };
  }
}

export async function getAbout(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  try {
    const result = await sock.fetchStatus(jid);
    return { ok: true, status: result?.status || null, setAt: result?.setAt || null };
  } catch {
    return { ok: true, status: null };
  }
}

export async function checkNumber(number) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(number);
  if (!jid) throw new Error("Número inválido");
  try {
    const [result] = await sock.onWhatsApp(jid.replace("@s.whatsapp.net", ""));
    return { ok: true, exists: !!result?.exists, jid: result?.jid || null };
  } catch {
    return { ok: false, exists: false, jid: null };
  }
}

export async function blockContact(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  await sock.updateBlockStatus(jid, "block");
  return { ok: true };
}

export async function unblockContact(chatIdOrNumber) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  await sock.updateBlockStatus(jid, "unblock");
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
  const me = sock.user?.id;
  if (!me) throw new Error("Usuário não identificado");
  await sock.updateProfilePicture(me, buffer);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — ORGANIZAÇÃO DE CONVERSAS
// ═══════════════════════════════════════════════════════════════

export async function pinChat(chatIdOrNumber, pin = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  await sock.chatModify({ pin: pin }, jid);
  const chat = chatsMap.get(jid);
  if (chat) chat.pinned = pin;
  return { ok: true };
}

export async function archiveChat(chatIdOrNumber, archive = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  await sock.chatModify({ archive: archive }, jid);
  const chat = chatsMap.get(jid);
  if (chat) chat.archived = archive;
  return { ok: true };
}

export async function muteChat(chatIdOrNumber, duration = null) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  const mute = duration ? Date.now() + (duration === -1 ? 365 * 24 * 60 * 60 * 1000 : duration * 1000) : null;
  await sock.chatModify({ mute: mute }, jid);
  const chat = chatsMap.get(jid);
  if (chat) chat.muted = !!duration;
  return { ok: true };
}

export async function setEphemeral(chatIdOrNumber, duration = 0) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatIdOrNumber);
  if (!jid) throw new Error("chat_id inválido");
  await sock.sendMessage(jid, { disappearingMessagesInChat: duration });
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS — GRUPOS
// ═══════════════════════════════════════════════════════════════

export async function getGroupMetadata(chatId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(chatId);
  const meta = await sock.groupMetadata(jid);
  return {
    id: meta.id,
    subject: meta.subject,
    desc: meta.desc,
    owner: meta.owner,
    creation: meta.creation,
    participants: meta.participants,
    size: meta.size || meta.participants?.length || 0,
    restrict: meta.restrict,
    announce: meta.announce,
    ephemeralDuration: meta.ephemeralDuration || 0,
    inviteCode: meta.inviteCode || null
  };
}

export async function resolveGroupNames(ids) {
  if (!sock) throw new Error("Socket não inicializado");
  const result = {};
  const limit = 3;
  for (let i = 0; i < ids.length; i += limit) {
    const batch = ids.slice(i, i + limit);
    const promises = batch.map(async (id) => {
      try {
        const meta = await sock.groupMetadata(id);
        result[id] = meta.subject || null;
      } catch {
        result[id] = null;
      }
    });
    await Promise.all(promises);
  }
  return result;
}

export async function createGroup(name, participants) {
  if (!sock) throw new Error("Socket não inicializado");
  const jids = participants.map(p => safeJid(p)).filter(Boolean);
  return await sock.groupCreate(name, jids);
}

export async function addToGroup(groupId, participants) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const jids = participants.map(p => safeJid(p)).filter(Boolean);
  return await sock.groupParticipantsUpdate(jid, jids, "add");
}

export async function removeFromGroup(groupId, participants) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const jids = participants.map(p => safeJid(p)).filter(Boolean);
  return await sock.groupParticipantsUpdate(jid, jids, "remove");
}

export async function promoteInGroup(groupId, participants) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const jids = participants.map(p => safeJid(p)).filter(Boolean);
  return await sock.groupParticipantsUpdate(jid, jids, "promote");
}

export async function demoteInGroup(groupId, participants) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const jids = participants.map(p => safeJid(p)).filter(Boolean);
  return await sock.groupParticipantsUpdate(jid, jids, "demote");
}

export async function getGroupInviteLink(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const code = await sock.groupInviteCode(jid);
  return { ok: true, link: `https://chat.whatsapp.com/${code}` };
}

export async function revokeGroupInvite(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  const code = await sock.groupRevokeInvite(jid);
  return { ok: true, link: `https://chat.whatsapp.com/${code}` };
}

export async function updateGroupSubject(groupId, subject) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  await sock.groupUpdateSubject(jid, subject);
  return { ok: true };
}

export async function updateGroupDescription(groupId, description) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  await sock.groupUpdateDescription(jid, description);
  return { ok: true };
}

export async function setGroupMessagesAdminsOnly(groupId, adminsOnly = true) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  await sock.groupSettingUpdate(jid, adminsOnly ? "announcement" : "not_announcement");
  return { ok: true };
}

export async function leaveGroup(groupId) {
  if (!sock) throw new Error("Socket não inicializado");
  const jid = safeJid(groupId);
  await sock.groupLeave(jid);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO DO WHATSAPP
// ═══════════════════════════════════════════════════════════════

export async function initWhatsApp() {
  status.lastError = null;

  const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  status.connection = "connecting";
  status.hasSocket = true;

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status.hasQr = true;
      status.qr = qr;
    }

    if (connection) {
      status.connection = connection;
    }

    const code = lastDisconnect?.error?.output?.statusCode ?? null;
    status.lastDisconnectCode = code;

    if (connection === "open") {
      status.hasQr = false;
      status.qr = null;
      status.lastError = null;
      console.log("WhatsApp conectado");
    }

    if (connection === "close") {
      console.log("WhatsApp desconectou", code || "");
      if (code === DisconnectReason.loggedOut) {
        status.lastError = "logged_out";
        return;
      }
      setTimeout(() => initWhatsApp(), 1500);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages || []) {
      const chatId = m.key?.remoteJid;
      if (!chatId) continue;
      await upsertMessage(chatId, m);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const update of updates) {
      const chatId = update.key?.remoteJid;
      const msgId = update.key?.id;
      if (!chatId || !msgId) continue;

      const msgs = messagesMap.get(chatId) || [];
      const msg = msgs.find(m => m.id === msgId);
      if (!msg) continue;

      if (update.update?.message) {
        const newText = extractText(update.update.message);
        if (newText) {
          msg.isEdited = true;
          msg.editedText = newText;
          msg.text = newText;
        }
      }

      if (update.update?.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
        msg.isRevoked = true;
        msg.text = "";
      }
    }
  });

  sock.ev.on("messages.reaction", (reactions) => {
    for (const { key, reaction } of reactions) {
      const chatId = key.remoteJid;
      const msgId = key.id;
      if (!chatId || !msgId) continue;

      const msgs = messagesMap.get(chatId) || [];
      const msg = msgs.find(m => m.id === msgId);
      if (!msg) continue;

      if (!msg.reactions) msg.reactions = [];

      const sender = reaction.key?.participant || reaction.key?.remoteJid || "unknown";
      msg.reactions = msg.reactions.filter(r => r.sender !== sender);

      if (reaction.text) {
        msg.reactions.push({ sender, emoji: reaction.text, timestamp: Date.now() });
      }
    }
  });

  sock.ev.on("presence.update", ({ id, presences }) => {
    presenceStore[id] = presences;
    updateLog.push({ ts: Date.now(), type: "presence", chatId: id });
  });

  sock.ev.on("message-receipt.update", (updates) => {
    for (const { key, receipt } of updates) {
      const chatId = key.remoteJid;
      const msgId = key.id;
      if (!chatId || !msgId) continue;

      if (!receiptStore[chatId]) receiptStore[chatId] = {};

      let sts = "sent";
      if (receipt.receiptTimestamp) sts = "delivered";
      if (receipt.readTimestamp) sts = "read";

      receiptStore[chatId][msgId] = {
        status: sts,
        deliveredAt: receipt.receiptTimestamp || null,
        readAt: receipt.readTimestamp || null,
        playedAt: receipt.playedTimestamp || null
      };

      const msgs = messagesMap.get(chatId) || [];
      const msg = msgs.find(m => m.id === msgId);
      if (msg) msg.status = sts;
    }
  });

  sock.ev.on("chats.update", (updates) => {
    for (const update of updates) {
      const chatId = update.id;
      if (!chatId) continue;

      const existing = chatsMap.get(chatId);
      if (!existing) continue;

      if (update.pin !== undefined) existing.pinned = !!update.pin;
      if (update.archive !== undefined) existing.archived = !!update.archive;
      if (update.mute !== undefined) existing.muted = update.mute > 0;
      if (update.unreadCount !== undefined) existing.unreadCount = update.unreadCount;
    }
  });

  return sock;
}
