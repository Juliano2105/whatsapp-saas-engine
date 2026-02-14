// ═══════════════════════════════════════════════════════════════
// session-manager.js — Gerenciador Multi-Sessão WhatsApp (Baileys)
// ✅ VERSÃO COMPLETA — Todos os endpoints do motor original
// ═══════════════════════════════════════════════════════════════

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const MEDIA_BASE_DIR = process.env.MEDIA_DIR || "./media";

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_BASE_DIR)) fs.mkdirSync(MEDIA_BASE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════
// WhatsAppSession — Uma instância isolada por sessionId
// ═══════════════════════════════════════════════════════════════
class WhatsAppSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.sock = null;
    this.status = {
      connection: "close",
      qr: null,
      hasQr: false,
      lastDisconnectCode: null,
      lastError: null,
    };
    this.chatsMap = new Map();
    this.messagesMap = new Map();
    this.presenceStore = {};
    this.receiptStore = {};
    this.lastMsgTimestamp = 0;
    this.authDir = path.join(SESSIONS_DIR, sessionId);
    this.mediaDir = path.join(MEDIA_BASE_DIR, sessionId);

    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });
    if (!fs.existsSync(this.mediaDir)) fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, { level: "silent" }),
      },
      logger: { level: "silent", child: () => ({ level: "silent", info: ()=>{}, error: ()=>{}, warn: ()=>{}, debug: ()=>{}, trace: ()=>{}, fatal: ()=>{}, child: ()=>({}) }) },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
    });

    // ─── Conexão ───
    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.status.qr = qr;
        this.status.hasQr = true;
        this.status.connection = "connecting";
        console.log(`[${this.sessionId}] QR gerado`);
      }
      if (connection === "open") {
        this.status.connection = "open";
        this.status.qr = null;
        this.status.hasQr = false;
        this.status.lastError = null;
        console.log(`[${this.sessionId}] Conectado!`);
        // Keep-alive a cada 25s
        this._keepAlive = setInterval(() => {
          try { this.sock?.sendPresenceUpdate("available"); } catch {}
        }, 25000);
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.status.connection = "close";
        this.status.lastDisconnectCode = code || null;
        this.status.lastError = lastDisconnect?.error?.message || null;
        if (this._keepAlive) clearInterval(this._keepAlive);
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`[${this.sessionId}] Desconectado (code: ${code}). Reconectar: ${shouldReconnect}`);
        if (shouldReconnect) setTimeout(() => this.connect(), 3000);
      }
    });

    this.sock.ev.on("creds.update", saveCreds);

    // ─── Histórico completo ───
    this.sock.ev.on("messaging-history.set", ({ chats, messages }) => {
      console.log(`[${this.sessionId}] History sync: ${chats.length} chats, ${messages.length} msgs`);
      for (const chat of chats) this.chatsMap.set(chat.id, chat);
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (!this.messagesMap.has(jid)) this.messagesMap.set(jid, []);
        this.messagesMap.get(jid).push(this._normalizeMsg(msg));
      }
    });

    // ─── Mensagens em tempo real ───
    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (!this.messagesMap.has(jid)) this.messagesMap.set(jid, []);
        const normalized = this._normalizeMsg(msg);
        this.messagesMap.get(jid).push(normalized);
        this.lastMsgTimestamp = Math.max(this.lastMsgTimestamp, normalized.timestamp || 0);
        // Atualiza chat
        const existing = this.chatsMap.get(jid) || { id: jid };
        existing.conversationTimestamp = normalized.timestamp;
        if (!msg.key.fromMe && type === "notify") {
          existing.unreadCount = (existing.unreadCount || 0) + 1;
        }
        this.chatsMap.set(jid, existing);
      }
    });

    // ─── Atualizações de chat ───
    this.sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) this.chatsMap.set(chat.id, { ...this.chatsMap.get(chat.id), ...chat });
    });
    this.sock.ev.on("chats.update", (updates) => {
      for (const u of updates) {
        if (this.chatsMap.has(u.id)) Object.assign(this.chatsMap.get(u.id), u);
      }
    });

    // ─── Presença ───
    this.sock.ev.on("presence.update", ({ id, presences }) => {
      this.presenceStore[id] = presences;
    });

    // ─── Confirmações de leitura ───
    this.sock.ev.on("message-receipt.update", (updates) => {
      for (const { key, receipt } of updates) {
        const jid = key.remoteJid;
        if (!this.receiptStore[jid]) this.receiptStore[jid] = {};
        this.receiptStore[jid][key.id] = receipt;
      }
    });

    return this;
  }

  // ─── Normalizar mensagem ───
  _normalizeMsg(raw) {
    const m = raw.message || {};
    const ts = typeof raw.messageTimestamp === "object"
      ? raw.messageTimestamp?.low || 0
      : Number(raw.messageTimestamp || 0);

    let body = m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || m.videoMessage?.caption
      || m.documentMessage?.fileName
      || "";

    let type = "text";
    if (m.imageMessage) type = "image";
    else if (m.videoMessage) type = "video";
    else if (m.audioMessage) type = "audio";
    else if (m.documentMessage) type = "document";
    else if (m.stickerMessage) type = "sticker";
    else if (m.contactMessage || m.contactsArrayMessage) type = "contact";
    else if (m.locationMessage) type = "location";
    else if (m.pollCreationMessage || m.pollCreationMessageV3) type = "poll";

    return {
      id: raw.key.id,
      chatId: raw.key.remoteJid,
      fromMe: raw.key.fromMe || false,
      participant: raw.key.participant || null,
      timestamp: ts,
      body,
      type,
      hasMedia: ["image", "video", "audio", "document", "sticker"].includes(type),
      pushName: raw.pushName || null,
      raw,
    };
  }

  _jid(chatId) {
    return chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
  }

  // ═══════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════

  getStatus() { return { ...this.status }; }

  listChats(limit = 50, cursor = null) {
    let arr = Array.from(this.chatsMap.values())
      .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0));
    if (cursor) {
      const idx = arr.findIndex(c => (c.conversationTimestamp || 0) < Number(cursor));
      if (idx >= 0) arr = arr.slice(idx);
    }
    const page = arr.slice(0, limit);
    const items = page.map(chat => {
      const msgs = this.messagesMap.get(chat.id) || [];
      const last = msgs[msgs.length - 1] || null;
      return {
        id: chat.id,
        name: chat.name || chat.subject || chat.id.replace(/@.*/, ""),
        conversationTimestamp: chat.conversationTimestamp || 0,
        unreadCount: chat.unreadCount || 0,
        pinned: chat.pinned || chat.pin ? true : false,
        archived: chat.archived || false,
        muted: chat.muted || chat.muteExpiration ? true : false,
        lastMessage: last ? { body: last.body, fromMe: last.fromMe, timestamp: last.timestamp, type: last.type } : null,
      };
    });
    const nextCursor = page.length === limit ? page[page.length - 1]?.conversationTimestamp : null;
    return { ok: true, chats: items, nextCursor };
  }

  listMessages(chatId, limit = 50, before = null) {
    let msgs = this.messagesMap.get(chatId) || [];
    msgs.sort((a, b) => a.timestamp - b.timestamp);
    if (before) {
      const idx = msgs.findIndex(m => m.timestamp >= Number(before));
      if (idx > 0) msgs = msgs.slice(0, idx);
    }
    const items = msgs.slice(-limit);
    return { ok: true, messages: items, hasMore: msgs.length > limit };
  }

  getUpdates(since) {
    const updated = [];
    for (const [jid, msgs] of this.messagesMap.entries()) {
      const recent = msgs.filter(m => m.timestamp > since);
      if (recent.length > 0) updated.push({ chatId: jid, messages: recent });
    }
    return { ok: true, updates: updated, serverTime: Math.floor(Date.now() / 1000) };
  }

  // ─── Envio ───
  async sendText(chatId, text) {
    const jid = this._jid(chatId);
    const sent = await this.sock.sendMessage(jid, { text });
    this._pushSent(jid, sent);
    return { ok: true, id: sent.key.id, timestamp: Number(sent.messageTimestamp || 0) };
  }

  async sendMedia(chatId, { type, buffer, mimetype, fileName, caption, ptt }) {
    const jid = this._jid(chatId);
    let content = {};
    if (type === "image") content = { image: buffer, mimetype: mimetype || "image/jpeg", caption };
    else if (type === "video") content = { video: buffer, mimetype: mimetype || "video/mp4", caption };
    else if (type === "audio") content = { audio: buffer, mimetype: mimetype || "audio/ogg; codecs=opus", ptt: ptt !== false };
    else content = { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: fileName || "file" };
    const sent = await this.sock.sendMessage(jid, content);
    this._pushSent(jid, sent);
    return { ok: true, id: sent.key.id };
  }

  async sendReply(chatId, text, quotedId) {
    const jid = this._jid(chatId);
    const msgs = this.messagesMap.get(jid) || [];
    const quotedMsg = msgs.find(m => m.id === quotedId);
    const quoted = quotedMsg?.raw ? quotedMsg.raw : { key: { id: quotedId, remoteJid: jid, fromMe: false } };
    const sent = await this.sock.sendMessage(jid, { text }, { quoted });
    this._pushSent(jid, sent);
    return { ok: true, id: sent.key.id };
  }

  async sendPoll(chatId, name, options, multiSelect = false) {
    const jid = this._jid(chatId);
    const sent = await this.sock.sendMessage(jid, {
      poll: { name, values: options, selectableCount: multiSelect ? 0 : 1 }
    });
    return { ok: true, id: sent.key.id };
  }

  async sendContact(chatId, { name, phone }) {
    const jid = this._jid(chatId);
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL:${phone}\nEND:VCARD`;
    const sent = await this.sock.sendMessage(jid, {
      contacts: { displayName: name, contacts: [{ vcard }] }
    });
    return { ok: true, id: sent.key.id };
  }

  async sendLocation(chatId, { latitude, longitude, name, address }) {
    const jid = this._jid(chatId);
    const sent = await this.sock.sendMessage(jid, {
      location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address }
    });
    return { ok: true, id: sent.key.id };
  }

  // ─── Ações de mensagem ───
  async markAsRead(chatId, messageIds) {
    const jid = this._jid(chatId);
    const keys = messageIds.map(id => ({ id, remoteJid: jid }));
    await this.sock.readMessages(keys);
    // Zera unread
    if (this.chatsMap.has(jid)) this.chatsMap.get(jid).unreadCount = 0;
  }

  async sendReaction(chatId, messageId, emoji) {
    const jid = this._jid(chatId);
    await this.sock.sendMessage(jid, {
      react: { text: emoji || "", key: { id: messageId, remoteJid: jid } }
    });
  }

  async deleteMessage(chatId, messageId, fromMe = true) {
    const jid = this._jid(chatId);
    await this.sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe } });
  }

  async editMessage(chatId, messageId, newText) {
    const jid = this._jid(chatId);
    const sent = await this.sock.sendMessage(jid, {
      text: newText,
      edit: { id: messageId, remoteJid: jid, fromMe: true },
    });
    return { ok: true, id: sent?.key?.id };
  }

  async forwardMessage(fromChatId, toChatId, messageId) {
    const fromJid = this._jid(fromChatId);
    const toJid = this._jid(toChatId);
    const msgs = this.messagesMap.get(fromJid) || [];
    const msg = msgs.find(m => m.id === messageId);
    if (!msg?.raw) throw new Error("Mensagem não encontrada");
    const sent = await this.sock.sendMessage(toJid, { forward: msg.raw });
    return { ok: true, id: sent?.key?.id };
  }

  // ─── Presença ───
  async sendPresence(chatId, type = "composing") {
    const jid = this._jid(chatId);
    await this.sock.sendPresenceUpdate(type, jid);
  }

  getPresenceStore() { return this.presenceStore; }
  getReceiptStore() { return this.receiptStore; }

  // ─── Organização de conversas ───
  async pinChat(chatId, pin = true) {
    const jid = this._jid(chatId);
    await this.sock.chatModify({ pin }, jid, []);
  }

  async archiveChat(chatId, archive = true) {
    const jid = this._jid(chatId);
    await this.sock.chatModify({ archive }, jid, []);
  }

  async muteChat(chatId, duration = null) {
    const jid = this._jid(chatId);
    const mute = duration ? Date.now() + duration * 1000 : undefined;
    await this.sock.chatModify({ mute }, jid, []);
  }

  async setEphemeral(chatId, duration = 0) {
    const jid = this._jid(chatId);
    await this.sock.sendMessage(jid, { disappearingMessagesInChat: duration });
  }

  // ─── Perfil e contatos ───
  async getProfilePicture(chatId) {
    const jid = this._jid(chatId);
    try {
      const url = await this.sock.profilePictureUrl(jid, "image");
      return { ok: true, url };
    } catch {
      return { ok: true, url: null };
    }
  }

  async getAbout(chatId) {
    const jid = this._jid(chatId);
    try {
      const result = await this.sock.fetchStatus(jid);
      return { ok: true, about: result?.status || null };
    } catch {
      return { ok: true, about: null };
    }
  }

  async checkNumber(number) {
    try {
      const [result] = await this.sock.onWhatsApp(number);
      return { ok: true, exists: result?.exists || false, jid: result?.jid || null };
    } catch {
      return { ok: false, exists: false };
    }
  }

  async blockContact(chatId) {
    const jid = this._jid(chatId);
    await this.sock.updateBlockStatus(jid, "block");
  }

  async unblockContact(chatId) {
    const jid = this._jid(chatId);
    await this.sock.updateBlockStatus(jid, "unblock");
  }

  async updateMyProfile({ name, about }) {
    if (name) await this.sock.updateProfileName(name);
    if (about) await this.sock.updateProfileStatus(about);
    return { ok: true };
  }

  async updateMyProfilePicture(buffer) {
    await this.sock.updateProfilePicture(this.sock.user.id, buffer);
    return { ok: true };
  }

  // ─── Grupos ───
  async getGroupMetadata(chatId) {
    const meta = await this.sock.groupMetadata(chatId);
    return {
      id: meta.id,
      subject: meta.subject,
      owner: meta.owner,
      participants: meta.participants,
      creation: meta.creation,
      desc: meta.desc,
    };
  }

  async resolveGroupNames(ids) {
    const results = [];
    for (const id of ids) {
      try {
        const meta = await this.sock.groupMetadata(id);
        results.push({ id, name: meta.subject });
      } catch {
        results.push({ id, name: null });
      }
    }
    return results;
  }

  async createGroup(name, participants) {
    const jids = participants.map(p => this._jid(p));
    const result = await this.sock.groupCreate(name, jids);
    return { id: result.id, subject: result.subject };
  }

  async addToGroup(groupId, participants) {
    const jids = participants.map(p => this._jid(p));
    return await this.sock.groupParticipantsUpdate(groupId, jids, "add");
  }

  async removeFromGroup(groupId, participants) {
    const jids = participants.map(p => this._jid(p));
    return await this.sock.groupParticipantsUpdate(groupId, jids, "remove");
  }

  async promoteInGroup(groupId, participants) {
    const jids = participants.map(p => this._jid(p));
    return await this.sock.groupParticipantsUpdate(groupId, jids, "promote");
  }

  async demoteInGroup(groupId, participants) {
    const jids = participants.map(p => this._jid(p));
    return await this.sock.groupParticipantsUpdate(groupId, jids, "demote");
  }

  async getGroupInviteLink(groupId) {
    const code = await this.sock.groupInviteCode(groupId);
    return { ok: true, link: `https://chat.whatsapp.com/${code}` };
  }

  async revokeGroupInvite(groupId) {
    const code = await this.sock.groupRevokeInvite(groupId);
    return { ok: true, link: `https://chat.whatsapp.com/${code}` };
  }

  async updateGroupSubject(groupId, subject) {
    await this.sock.groupUpdateSubject(groupId, subject);
  }

  async updateGroupDescription(groupId, description) {
    await this.sock.groupUpdateDescription(groupId, description);
  }

  async setGroupMessagesAdminsOnly(groupId, adminsOnly = true) {
    await this.sock.groupSettingUpdate(groupId, adminsOnly ? "announcement" : "not_announcement");
  }

  async leaveGroup(groupId) {
    await this.sock.groupLeave(groupId);
  }

  // ─── Reiniciar ───
  async restart() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    if (this.sock) try { this.sock.end(); } catch {}
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    this.status = { connection: "close", qr: null, hasQr: false, lastDisconnectCode: null, lastError: null };
    this.chatsMap.clear();
    this.messagesMap.clear();
    this.presenceStore = {};
    this.receiptStore = {};
    await this.connect();
  }

  async destroy() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    if (this.sock) try { this.sock.end(); } catch {}
  }

  _pushSent(jid, sent) {
    if (!this.messagesMap.has(jid)) this.messagesMap.set(jid, []);
    this.messagesMap.get(jid).push(this._normalizeMsg(sent));
  }
}

// ═══════════════════════════════════════════════════════════════
// SessionManager (singleton)
// ═══════════════════════════════════════════════════════════════
class SessionManager {
  constructor() { this.sessions = new Map(); }

  get(sessionId) { return this.sessions.get(sessionId) || null; }

  async getOrCreate(sessionId) {
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    const session = new WhatsAppSession(sessionId);
    this.sessions.set(sessionId, session);
    await session.connect();
    return session;
  }

  async destroy(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.destroy();
    this.sessions.delete(sessionId);
    return true;
  }

  listSessions() {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({ id, ...s.getStatus() }));
  }

  async restoreFromDisk() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    console.log(`[SessionManager] Encontradas ${dirs.length} sessões no disco`);
    for (const dir of dirs) {
      try {
        await this.getOrCreate(dir);
        console.log(`[SessionManager] Restaurada: ${dir}`);
      } catch (err) {
        console.error(`[SessionManager] Erro ao restaurar ${dir}:`, err.message);
      }
    }
  }
}

export const sessionManager = new SessionManager();
export { MEDIA_BASE_DIR };
