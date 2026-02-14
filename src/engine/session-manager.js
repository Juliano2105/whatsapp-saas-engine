// ═══════════════════════════════════════════════════════════════
// session-manager.js — Gerenciador Multi-Sessão WhatsApp (Baileys)
// Cada sessão = 1 número WhatsApp conectado, isolado por sessionId
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
import pino from "pino";

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const MEDIA_BASE_DIR = process.env.MEDIA_DIR || "./media";

// Garante que as pastas existem
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_BASE_DIR)) fs.mkdirSync(MEDIA_BASE_DIR, { recursive: true });

// ─── Classe WhatsAppSession ──────────────────────────────────
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
    this.lastMsgTimestamp = 0;
    this.authDir = path.join(SESSIONS_DIR, sessionId);
    this.mediaDir = path.join(MEDIA_BASE_DIR, sessionId);

    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });
    if (!fs.existsSync(this.mediaDir)) fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: "silent" });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
    });

    // ─── Eventos de conexão ───
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
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.status.connection = "close";
        this.status.lastDisconnectCode = code || null;
        this.status.lastError = lastDisconnect?.error?.message || null;

        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`[${this.sessionId}] Desconectado (code: ${code}). Reconectar: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => this.connect(), 3000);
        } else {
          this.status.qr = null;
          this.status.hasQr = false;
        }
      }
    });

    this.sock.ev.on("creds.update", saveCreds);

    // ─── Histórico de mensagens (sync completo) ───
    this.sock.ev.on("messaging-history.set", ({ chats, messages }) => {
      console.log(`[${this.sessionId}] History sync: ${chats.length} chats, ${messages.length} msgs`);
      for (const chat of chats) {
        this.chatsMap.set(chat.id, chat);
      }
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
        if (this.chatsMap.has(jid)) {
          const chat = this.chatsMap.get(jid);
          chat.conversationTimestamp = normalized.timestamp;
          if (!msg.key.fromMe && type === "notify") {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
          }
        } else {
          this.chatsMap.set(jid, {
            id: jid,
            conversationTimestamp: normalized.timestamp,
            unreadCount: msg.key.fromMe ? 0 : 1,
          });
        }
      }
    });

    // ─── Atualizações de chat ───
    this.sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        this.chatsMap.set(chat.id, { ...this.chatsMap.get(chat.id), ...chat });
      }
    });

    this.sock.ev.on("chats.update", (updates) => {
      for (const update of updates) {
        if (this.chatsMap.has(update.id)) {
          Object.assign(this.chatsMap.get(update.id), update);
        }
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

  // ─── API pública ───
  getStatus() {
    return { ...this.status };
  }

  listChats(limit = 30, cursor = null) {
    let arr = Array.from(this.chatsMap.values())
      .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0));

    if (cursor) {
      const idx = arr.findIndex(c => c.id === cursor);
      if (idx >= 0) arr = arr.slice(idx + 1);
    }

    const items = arr.slice(0, limit).map(chat => {
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

    return { ok: true, chats: items, hasMore: arr.length > limit };
  }

  listMessages(chatId, limit = 50, before = null) {
    let msgs = this.messagesMap.get(chatId) || [];
    msgs.sort((a, b) => a.timestamp - b.timestamp);

    if (before) {
      const idx = msgs.findIndex(m => m.timestamp >= before);
      if (idx > 0) msgs = msgs.slice(0, idx);
    }

    const items = msgs.slice(-limit);
    return { ok: true, messages: items, hasMore: msgs.length > limit };
  }

  getUpdates(since) {
    const updated = [];
    for (const [jid, msgs] of this.messagesMap.entries()) {
      const recent = msgs.filter(m => m.timestamp > since);
      if (recent.length > 0) {
        updated.push({ chatId: jid, messages: recent });
      }
    }
    return {
      ok: true,
      updates: updated,
      serverTime: Math.floor(Date.now() / 1000),
    };
  }

  async sendText(chatId, text) {
    const jid = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    const sent = await this.sock.sendMessage(jid, { text });
    const normalized = this._normalizeMsg(sent);
    if (!this.messagesMap.has(jid)) this.messagesMap.set(jid, []);
    this.messagesMap.get(jid).push(normalized);
    return { ok: true, id: sent.key.id, timestamp: normalized.timestamp };
  }

  async sendMedia(chatId, { type, buffer, mimetype, fileName, caption, ptt }) {
    const jid = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    let content = {};
    if (type === "image") content = { image: buffer, mimetype: mimetype || "image/jpeg", caption };
    else if (type === "video") content = { video: buffer, mimetype: mimetype || "video/mp4", caption };
    else if (type === "audio") content = { audio: buffer, mimetype: mimetype || "audio/ogg; codecs=opus", ptt: ptt !== false };
    else if (type === "document") content = { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: fileName || "file" };
    else content = { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: fileName || "file" };

    const sent = await this.sock.sendMessage(jid, content);
    return { ok: true, id: sent.key.id };
  }

  async getProfilePicture(chatId) {
    const jid = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    try {
      const url = await this.sock.profilePictureUrl(jid, "image");
      return { ok: true, url };
    } catch {
      return { ok: true, url: null };
    }
  }

  async getGroupMetadata(chatId) {
    const jid = chatId.includes("@") ? chatId : chatId;
    const meta = await this.sock.groupMetadata(jid);
    return {
      id: meta.id,
      subject: meta.subject,
      owner: meta.owner,
      participants: meta.participants,
      creation: meta.creation,
      desc: meta.desc,
    };
  }

  async resolveGroupNames(chatIds) {
    const results = [];
    for (const id of chatIds) {
      try {
        const meta = await this.sock.groupMetadata(id);
        results.push({ id, name: meta.subject });
      } catch {
        results.push({ id, name: null });
      }
    }
    return results;
  }

  async restart() {
    if (this.sock) {
      try { this.sock.end(); } catch {}
    }
    // Limpa credenciais para forçar novo QR
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    this.status = { connection: "close", qr: null, hasQr: false, lastDisconnectCode: null, lastError: null };
    this.chatsMap.clear();
    this.messagesMap.clear();
    await this.connect();
  }

  async destroy() {
    if (this.sock) {
      try { this.sock.end(); } catch {}
    }
  }
}

// ─── Session Manager (singleton) ─────────────────────────────
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
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      ...s.getStatus(),
    }));
  }

  async restoreFromDisk() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

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
