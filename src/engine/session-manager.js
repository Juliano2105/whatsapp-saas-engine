// ═══════════════════════════════════════════════════════════════
// session-manager.js — Gerenciador Multi-Sessão WhatsApp
// Caminho no Railway: src/engine/session-manager.js
// ═══════════════════════════════════════════════════════════════

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { Boom } from "@hapi/boom";

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
export const MEDIA_BASE_DIR = process.env.MEDIA_DIR || "./media";

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_BASE_DIR)) fs.mkdirSync(MEDIA_BASE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════
// CLASSE: WhatsAppSession
// ═══════════════════════════════════════════════════════════════

class WhatsAppSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.sock = null;
    this.status = { connection: "close", qr: null, hasQr: false };
    this.chats = {};
    this.messages = {};
    this.presenceStore = {};
    this.receiptStore = {};
    this.updates = [];
    this.updateSeq = 0;
    this.keepAliveInterval = null;
    this.logger = pino({ level: "silent" });
  }

  get sessionPath() {
    return path.join(SESSIONS_DIR, this.sessionId);
  }

  get mediaPath() {
    const p = path.join(MEDIA_BASE_DIR, this.sessionId);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      logger: this.logger,
      printQRInTerminal: false,
      syncFullHistory: true,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status.qr = qr;
        this.status.hasQr = true;
        this.status.connection = "connecting";
        console.log(`[${this.sessionId}] QR Code gerado`);
      }

      if (connection === "open") {
        this.status.connection = "open";
        this.status.qr = null;
        this.status.hasQr = false;
        console.log(`[${this.sessionId}] Conectado!`);
        this._startKeepAlive();
      }

      if (connection === "close") {
        this.status.connection = "close";
        this._stopKeepAlive();

        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`[${this.sessionId}] Desconectado. Razão: ${reason}`);

        if (reason === DisconnectReason.loggedOut) {
          console.log(`[${this.sessionId}] Logout — limpando sessão`);
          if (fs.existsSync(this.sessionPath)) {
            fs.rmSync(this.sessionPath, { recursive: true, force: true });
          }
        } else {
          console.log(`[${this.sessionId}] Reconectando em 3s...`);
          setTimeout(() => this.start(), 3000);
        }
      }
    });

    this.sock.ev.on("messaging-history.set", ({ chats: newChats, messages: newMsgs }) => {
      console.log(`[${this.sessionId}] Histórico: ${newChats.length} chats, ${newMsgs.length} msgs`);
      for (const chat of newChats) {
        this.chats[chat.id] = {
          id: chat.id,
          name: chat.name || chat.id,
          lastTimestamp: chat.conversationTimestamp
            ? (typeof chat.conversationTimestamp === "object"
              ? chat.conversationTimestamp.low
              : Number(chat.conversationTimestamp))
            : 0,
          unreadCount: chat.unreadCount || 0,
          lastMessage: chat.lastMessage?.message
            ? this._extractBody(chat.lastMessage.message)
            : null,
          isGroup: chat.id.endsWith("@g.us"),
          raw: chat,
        };
      }
      for (const msg of newMsgs) {
        const chatId = msg.key.remoteJid;
        if (!this.messages[chatId]) this.messages[chatId] = [];
        this.messages[chatId].push(this._normalizeMessage(msg));
      }
      this._pushUpdate("history_sync", { chats: newChats.length, messages: newMsgs.length });
    });

    this.sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        this.chats[chat.id] = {
          ...this.chats[chat.id],
          id: chat.id,
          name: chat.name || chat.id,
          lastTimestamp: chat.conversationTimestamp
            ? (typeof chat.conversationTimestamp === "object"
              ? chat.conversationTimestamp.low
              : Number(chat.conversationTimestamp))
            : this.chats[chat.id]?.lastTimestamp || 0,
          unreadCount: chat.unreadCount ?? this.chats[chat.id]?.unreadCount ?? 0,
          isGroup: chat.id.endsWith("@g.us"),
          raw: chat,
        };
      }
    });

    this.sock.ev.on("chats.update", (updates) => {
      for (const update of updates) {
        if (this.chats[update.id]) {
          Object.assign(this.chats[update.id], update);
          if (update.conversationTimestamp) {
            this.chats[update.id].lastTimestamp =
              typeof update.conversationTimestamp === "object"
                ? update.conversationTimestamp.low
                : Number(update.conversationTimestamp);
          }
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
      for (const msg of msgs) {
        const chatId = msg.key.remoteJid;
        if (!chatId) continue;
        const normalized = this._normalizeMessage(msg);

        if (!this.messages[chatId]) this.messages[chatId] = [];
        const existing = this.messages[chatId].findIndex((m) => m.id === normalized.id);
        if (existing >= 0) {
          this.messages[chatId][existing] = normalized;
        } else {
          this.messages[chatId].push(normalized);
        }

        if (this.chats[chatId]) {
          this.chats[chatId].lastTimestamp = normalized.timestamp;
          this.chats[chatId].lastMessage = normalized.body;
          if (!msg.key.fromMe && type === "notify") {
            this.chats[chatId].unreadCount = (this.chats[chatId].unreadCount || 0) + 1;
          }
        } else {
          this.chats[chatId] = {
            id: chatId,
            name: msg.pushName || chatId,
            lastTimestamp: normalized.timestamp,
            lastMessage: normalized.body,
            unreadCount: msg.key.fromMe ? 0 : 1,
            isGroup: chatId.endsWith("@g.us"),
          };
        }

        this._pushUpdate("new_message", { chatId, message: normalized });

        // Salvar mídia
        if (msg.message) {
          try {
            await this._saveMedia(msg);
          } catch (err) {
            console.error(`[${this.sessionId}] Erro _saveMedia:`, err.message);
          }
        }
      }
    });

    this.sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const chatId = key.remoteJid;
        if (!chatId || !this.messages[chatId]) continue;
        const idx = this.messages[chatId].findIndex((m) => m.id === key.id);
        if (idx >= 0) {
          Object.assign(this.messages[chatId][idx], update);
        }
      }
    });

    this.sock.ev.on("presence.update", ({ id, presences }) => {
      this.presenceStore[id] = presences;
    });

    this.sock.ev.on("message-receipt.update", (events) => {
      for (const { key, receipt } of events) {
        const chatId = key.remoteJid;
        if (!chatId) continue;
        if (!this.receiptStore[chatId]) this.receiptStore[chatId] = {};
        this.receiptStore[chatId][key.id] = receipt;
      }
    });
  }

  // ─── Helpers ───

  _startKeepAlive() {
    this._stopKeepAlive();
    this.keepAliveInterval = setInterval(async () => {
      try {
        if (this.sock && this.status.connection === "open") {
          await this.sock.sendPresenceUpdate("available");
        }
      } catch {}
    }, 25000);
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  _pushUpdate(type, data) {
    this.updateSeq++;
    this.updates.push({ seq: this.updateSeq, type, data, ts: Date.now() });
    if (this.updates.length > 5000) this.updates = this.updates.slice(-3000);
  }

  _extractBody(message) {
    if (!message) return null;
    return (
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.documentMessage?.fileName ||
      (message.audioMessage ? "🎵 Áudio" : null) ||
      (message.stickerMessage ? "🏷️ Sticker" : null) ||
      (message.contactMessage ? "👤 Contato" : null) ||
      (message.locationMessage ? "📍 Localização" : null) ||
      (message.pollCreationMessage ? "📊 Enquete" : null) ||
      null
    );
  }

  _detectMediaInfo(msgObj) {
    if (msgObj.imageMessage) return { sub: msgObj.imageMessage, type: "image", ext: ".jpg" };
    if (msgObj.videoMessage) return { sub: msgObj.videoMessage, type: "video", ext: ".mp4" };
    if (msgObj.audioMessage) return { sub: msgObj.audioMessage, type: "audio", ext: msgObj.audioMessage.ptt ? ".ogg" : ".mp3" };
    if (msgObj.documentMessage) {
      const fname = msgObj.documentMessage.fileName || "file";
      const ext = path.extname(fname) || ".bin";
      return { sub: msgObj.documentMessage, type: "document", ext };
    }
    if (msgObj.stickerMessage) return { sub: msgObj.stickerMessage, type: "sticker", ext: ".webp" };
    return null;
  }

  _normalizeMessage(raw) {
    const msg = raw.message || {};
    const key = raw.key || {};
    const ts =
      typeof raw.messageTimestamp === "object"
        ? raw.messageTimestamp?.low || 0
        : Number(raw.messageTimestamp || 0);

    let type = "text";
    const mediaInfo = this._detectMediaInfo(msg);
    if (mediaInfo) {
      type = mediaInfo.type;
    } else if (msg.contactMessage || msg.contactsArrayMessage) {
      type = "contact";
    } else if (msg.locationMessage || msg.liveLocationMessage) {
      type = "location";
    } else if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
      type = "poll";
    }

    return {
      id: key.id,
      chatId: key.remoteJid,
      fromMe: key.fromMe || false,
      direction: key.fromMe ? "outgoing" : "incoming",
      timestamp: ts,
      body: this._extractBody(msg),
      type,
      senderName: raw.pushName || null,
      senderJid: key.participant || key.remoteJid,
      quoted: msg.extendedTextMessage?.contextInfo?.quotedMessage
        ? {
            id: msg.extendedTextMessage.contextInfo.stanzaId,
            body: this._extractBody(msg.extendedTextMessage.contextInfo.quotedMessage),
          }
        : null,
      raw,
      // Campos de mídia — preenchidos pelo _saveMedia após download
      mediaUrl: null,
      mimeType: mediaInfo?.sub?.mimetype || null,
      fileName: mediaInfo?.sub?.fileName || null,
      fileSize: mediaInfo?.sub?.fileLength || null,
      duration: mediaInfo?.sub?.seconds || null,
      caption: mediaInfo?.sub?.caption || null,
    };
  }

  async _saveMedia(msg) {
    const msgObj = msg.message || {};
    const mediaInfo = this._detectMediaInfo(msgObj);
    if (!mediaInfo) return null;

    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      const fileName = `${msg.key.id}${mediaInfo.ext}`;
      const filePath = path.join(this.mediaPath, fileName);
      fs.writeFileSync(filePath, buffer);
      console.log(`[${this.sessionId}] Mídia salva: ${fileName} (${buffer.length} bytes)`);

      // Atualizar a mensagem no store com a URL da mídia
      const chatId = msg.key.remoteJid;
      if (this.messages[chatId]) {
        const idx = this.messages[chatId].findIndex((m) => m.id === msg.key.id);
        if (idx >= 0) {
          this.messages[chatId][idx].mediaUrl = `/media/${this.sessionId}/${fileName}`;
          this.messages[chatId][idx].mimeType = mediaInfo.sub.mimetype || null;
          this.messages[chatId][idx].duration = mediaInfo.sub.seconds || null;
          this.messages[chatId][idx].fileName = mediaInfo.sub.fileName || null;
          this.messages[chatId][idx].caption = mediaInfo.sub.caption || null;
          this.messages[chatId][idx].fileSize = mediaInfo.sub.fileLength || buffer.length;
        }
      }
      return fileName;
    } catch (err) {
      console.error(`[${this.sessionId}] Erro ao salvar mídia ${msg.key.id}:`, err.message);
      return null;
    }
  }

  // ─── API Pública ───

  getStatus() {
    return {
      connection: this.status.connection,
      qr: this.status.qr,
      hasQr: this.status.hasQr,
      sessionId: this.sessionId,
      chatCount: Object.keys(this.chats).length,
    };
  }

  listChats(limit = 50, cursor = null) {
    const all = Object.values(this.chats).sort(
      (a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0)
    );
    let filtered = all;
    if (cursor) {
      const idx = all.findIndex((c) => (c.lastTimestamp || 0) < Number(cursor));
      filtered = idx >= 0 ? all.slice(idx) : [];
    }
    const page = filtered.slice(0, limit);
    const nextCursor =
      page.length === limit ? page[page.length - 1]?.lastTimestamp : null;
    return { ok: true, chats: page, nextCursor };
  }

  listMessages(chatId, limit = 50, before = null) {
    const msgs = (this.messages[chatId] || []).sort(
      (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
    );
    let filtered = msgs;
    if (before) {
      filtered = msgs.filter((m) => m.timestamp < Number(before));
    }
    return { ok: true, messages: filtered.slice(0, limit).reverse() };
  }

  async sendText(chatId, text) {
    const result = await this.sock.sendMessage(chatId, { text });
    return { ok: true, id: result?.key?.id };
  }

  async sendMedia(chatId, { type, buffer, mimetype, fileName, caption, ptt }) {
    const content = {};
    if (type === "image") {
      content.image = buffer;
      if (caption) content.caption = caption;
      if (mimetype) content.mimetype = mimetype;
    } else if (type === "video") {
      content.video = buffer;
      if (caption) content.caption = caption;
      if (mimetype) content.mimetype = mimetype;
    } else if (type === "audio") {
      content.audio = buffer;
      content.mimetype = mimetype || "audio/ogg; codecs=opus";
      content.ptt = ptt !== false;
    } else if (type === "document") {
      content.document = buffer;
      content.mimetype = mimetype || "application/octet-stream";
      content.fileName = fileName || "file";
    } else if (type === "sticker") {
      content.sticker = buffer;
    }
    const result = await this.sock.sendMessage(chatId, content);

    // Salvar a mídia enviada no disco também
    if (result?.key?.id) {
      try {
        let ext = ".bin";
        if (type === "image") ext = ".jpg";
        else if (type === "video") ext = ".mp4";
        else if (type === "audio") ext = ptt ? ".ogg" : ".mp3";
        else if (type === "sticker") ext = ".webp";
        else if (type === "document") ext = path.extname(fileName || "") || ".bin";

        const mediaFileName = `${result.key.id}${ext}`;
        const filePath = path.join(this.mediaPath, mediaFileName);
        fs.writeFileSync(filePath, buffer);
        console.log(`[${this.sessionId}] Mídia enviada salva: ${mediaFileName}`);
      } catch (err) {
        console.error(`[${this.sessionId}] Erro ao salvar mídia enviada:`, err.message);
      }
    }

    return { ok: true, id: result?.key?.id };
  }

  async sendReply(chatId, text, quotedId) {
    const msgs = this.messages[chatId] || [];
    const quoted = msgs.find((m) => m.id === quotedId);
    const result = await this.sock.sendMessage(
      chatId,
      { text },
      { quoted: quoted?.raw }
    );
    return { ok: true, id: result?.key?.id };
  }

  async sendPoll(chatId, name, options, multiSelect = false) {
    const result = await this.sock.sendMessage(chatId, {
      poll: { name, values: options, selectableCount: multiSelect ? 0 : 1 },
    });
    return { ok: true, id: result?.key?.id };
  }

  async sendContact(chatId, { name, phone }) {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL:${phone}\nEND:VCARD`;
    const result = await this.sock.sendMessage(chatId, {
      contacts: { displayName: name, contacts: [{ vcard }] },
    });
    return { ok: true, id: result?.key?.id };
  }

  async sendLocation(chatId, { latitude, longitude, name, address }) {
    const result = await this.sock.sendMessage(chatId, {
      location: {
        degreesLatitude: Number(latitude),
        degreesLongitude: Number(longitude),
        name,
        address,
      },
    });
    return { ok: true, id: result?.key?.id };
  }

  async markAsRead(chatId, messageIds) {
    const keys = messageIds.map((id) => ({
      remoteJid: chatId,
      id,
      fromMe: false,
    }));
    await this.sock.readMessages(keys);
    if (this.chats[chatId]) this.chats[chatId].unreadCount = 0;
  }

  async sendReaction(chatId, messageId, emoji) {
    await this.sock.sendMessage(chatId, {
      react: { text: emoji, key: { remoteJid: chatId, id: messageId } },
    });
  }

  async deleteMessage(chatId, messageId, fromMe = true) {
    await this.sock.sendMessage(chatId, {
      delete: { remoteJid: chatId, id: messageId, fromMe },
    });
  }

  async editMessage(chatId, messageId, newText) {
    const result = await this.sock.sendMessage(chatId, {
      text: newText,
      edit: { remoteJid: chatId, id: messageId, fromMe: true },
    });
    return { ok: true, id: result?.key?.id };
  }

  async forwardMessage(fromChatId, toChatId, messageId) {
    const msgs = this.messages[fromChatId] || [];
    const msg = msgs.find((m) => m.id === messageId);
    if (!msg?.raw) throw new Error("Mensagem não encontrada");
    const result = await this.sock.sendMessage(toChatId, {
      forward: msg.raw,
    });
    return { ok: true, id: result?.key?.id };
  }

  async sendPresence(chatId, type = "composing") {
    await this.sock.sendPresenceUpdate(type, chatId);
  }

  getPresenceStore() {
    return this.presenceStore;
  }

  getReceiptStore() {
    return this.receiptStore;
  }

  async pinChat(chatId, pin) {
    await this.sock.chatModify({ pin }, chatId, []);
  }

  async archiveChat(chatId, archive) {
    await this.sock.chatModify({ archive }, chatId, []);
  }

  async muteChat(chatId, duration) {
    const mute = duration ? Date.now() + duration * 1000 : null;
    await this.sock.chatModify({ mute }, chatId, []);
  }

  async setEphemeral(chatId, duration) {
    await this.sock.sendMessage(chatId, { disappearingMessagesInChat: duration || false });
  }

  async getProfilePicture(chatId) {
    try {
      const url = await this.sock.profilePictureUrl(chatId, "image");
      return { ok: true, url };
    } catch {
      return { ok: true, url: null };
    }
  }

  async getAbout(chatId) {
    try {
      const result = await this.sock.fetchStatus(chatId);
      return { ok: true, about: result?.status || null };
    } catch {
      return { ok: true, about: null };
    }
  }

  async checkNumber(number) {
    try {
      const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
      const [result] = await this.sock.onWhatsApp(jid);
      return { ok: true, exists: result?.exists || false, jid: result?.jid || jid };
    } catch {
      return { ok: false, exists: false };
    }
  }

  async blockContact(chatId) {
    await this.sock.updateBlockStatus(chatId, "block");
  }

  async unblockContact(chatId) {
    await this.sock.updateBlockStatus(chatId, "unblock");
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

  async getGroupMetadata(chatId) {
    return await this.sock.groupMetadata(chatId);
  }

  async resolveGroupNames(ids) {
    const result = {};
    for (const id of ids) {
      try {
        const meta = await this.sock.groupMetadata(id);
        result[id] = meta.subject || id;
      } catch {
        result[id] = id;
      }
    }
    return result;
  }

  async createGroup(name, participants) {
    return await this.sock.groupCreate(name, participants);
  }

  async addToGroup(groupId, participants) {
    return await this.sock.groupParticipantsUpdate(groupId, participants, "add");
  }

  async removeFromGroup(groupId, participants) {
    return await this.sock.groupParticipantsUpdate(groupId, participants, "remove");
  }

  async promoteInGroup(groupId, participants) {
    return await this.sock.groupParticipantsUpdate(groupId, participants, "promote");
  }

  async demoteInGroup(groupId, participants) {
    return await this.sock.groupParticipantsUpdate(groupId, participants, "demote");
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

  async setGroupMessagesAdminsOnly(groupId, adminsOnly) {
    await this.sock.groupSettingUpdate(groupId, adminsOnly ? "announcement" : "not_announcement");
  }

  async leaveGroup(groupId) {
    await this.sock.groupLeave(groupId);
  }

  getUpdates(since = 0) {
    const filtered = this.updates.filter((u) => u.seq > since);
    return {
      ok: true,
      updates: filtered.slice(-200),
      seq: this.updateSeq,
      chatCount: Object.keys(this.chats).length,
      connection: this.status.connection,
    };
  }

  async restart() {
    this._stopKeepAlive();
    try { this.sock?.end(); } catch {}
    if (fs.existsSync(this.sessionPath)) {
      fs.rmSync(this.sessionPath, { recursive: true, force: true });
    }
    this.status = { connection: "close", qr: null, hasQr: false };
    await this.start();
  }

  destroy() {
    this._stopKeepAlive();
    try { this.sock?.end(); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// CLASSE: SessionManager
// ═══════════════════════════════════════════════════════════════

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  async getOrCreate(sessionId) {
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    const session = new WhatsAppSession(sessionId);
    this.sessions.set(sessionId, session);
    await session.start();
    return session;
  }

  async destroy(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.destroy();
    this.sessions.delete(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    return true;
  }

  listSessions() {
    const list = [];
    for (const [id, session] of this.sessions) {
      list.push({ sessionId: id, ...session.getStatus() });
    }
    return list;
  }

  async restoreFromDisk() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    console.log(`[SessionManager] Restaurando ${dirs.length} sessão(ões)...`);
    for (const dir of dirs) {
      try {
        await this.getOrCreate(dir);
        console.log(`[SessionManager] ✅ ${dir} restaurada`);
      } catch (err) {
        console.error(`[SessionManager] ❌ ${dir}:`, err.message);
      }
    }
  }
}

export const sessionManager = new SessionManager();
