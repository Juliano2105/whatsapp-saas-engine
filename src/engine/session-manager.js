// ═══════════════════════════════════════════════════════════════
// engine/session-manager.js — Gerenciador Multi-Sessão WhatsApp
// ═══════════════════════════════════════════════════════════════

import * as baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = baileys;

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const MEDIA_BASE_DIR = process.env.MEDIA_DIR || "./media";

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_BASE_DIR)) fs.mkdirSync(MEDIA_BASE_DIR, { recursive: true });

// ─── Sessão individual ─────────────────────────────────────────

class WhatsAppSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.sock = null;
    this.chatsMap = new Map();
    this.messagesMap = new Map();
    this.recentMessages = [];
    this.MAX_RECENT = 5000;

    this.status = {
      connection: "close",
      lastDisconnectCode: null,
      hasQr: false,
      qr: null,
      lastError: null,
    };

    this.authFolder = path.join(SESSIONS_DIR, sessionId, "auth");
    this.mediaFolder = path.join(MEDIA_BASE_DIR, sessionId);

    if (!fs.existsSync(this.authFolder)) fs.mkdirSync(this.authFolder, { recursive: true });
    if (!fs.existsSync(this.mediaFolder)) fs.mkdirSync(this.mediaFolder, { recursive: true });
  }

  // ─── PROXY via Edge Function ─────────────────────────────────
  async buildProxyAgent() {
    try {
      const url = process.env.SUPABASE_URL;
      const key = process.env.ENGINE_AUTOMATION_KEY;
      if (!url || !key) return undefined;

      const res = await fetch(
        `${url}/functions/v1/get-proxy-config?engine_id=${this.sessionId}`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) {
        console.error(`[${this.sessionId}] get-proxy-config HTTP ${res.status}`);
        return undefined;
      }
      const data = await res.json();
      if (!data.enabled) return undefined;

      const user = data.username || "";
      const pass = data.password || "";
      const auth = user ? `${user}:${pass}@` : "";

      const proxyUrl = data.protocol === "socks5"
        ? `socks5://${auth}${data.host}:${data.port}`
        : `http://${auth}${data.host}:${data.port}`;

      const agent = data.protocol === "socks5"
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);

      console.log(`[${this.sessionId}] Proxy ${data.protocol} configurado: ${data.host}:${data.port}`);
      return agent;
    } catch (err) {
      console.error(`[${this.sessionId}] Erro ao carregar proxy:`, err.message);
      return undefined;
    }
  }
  async checkExternalIp() {
    try {
      const options = {};
      if (this.proxyAgent) {
        options.agent = this.proxyAgent;
      }
      const res = await fetch("https://api.ipify.org?format=json", options);
      if (res.ok) {
        const data = await res.json();
        return data.ip;
      }
    } catch (err) {
      console.error(`[session:${this.sessionId}][proxy] IP check failed:`, err.message);
    }
    return null;
  }


  // ─── Detectar tipo de mídia ──────────────────────────────────
  detectMediaType(msg) {
    const msgObj = msg.message || {};
    if (msgObj.imageMessage) return { type: "image", sub: msgObj.imageMessage, ext: ".jpg" };
    if (msgObj.videoMessage) return { type: "video", sub: msgObj.videoMessage, ext: ".mp4" };
    if (msgObj.audioMessage)
      return { type: "audio", sub: msgObj.audioMessage, ext: msgObj.audioMessage.ptt ? ".ogg" : ".mp3" };
    if (msgObj.stickerMessage) return { type: "sticker", sub: msgObj.stickerMessage, ext: ".webp" };
    if (msgObj.documentMessage) {
      const fname = msgObj.documentMessage.fileName || "file";
      const ext = path.extname(fname) || ".bin";
      return { type: "document", sub: msgObj.documentMessage, ext };
    }
    return null;
  }

  // ─── Baixar e salvar mídia ───────────────────────────────────
  async downloadAndSaveMedia(msg) {
    const mediaInfo = this.detectMediaType(msg);
    if (!mediaInfo) return null;

    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      const fileName = `${msg.key.id}${mediaInfo.ext}`;
      const filePath = path.join(this.mediaFolder, fileName);
      fs.writeFileSync(filePath, buffer);

      return {
        type: mediaInfo.type,
        mediaUrl: `/media/${this.sessionId}/${fileName}`,
        mimeType: mediaInfo.sub.mimetype || null,
        fileName: mediaInfo.sub.fileName || mediaInfo.sub.title || null,
        fileSize: mediaInfo.sub.fileLength || buffer.length,
        duration: mediaInfo.sub.seconds || null,
        caption: mediaInfo.sub.caption || null,
        width: mediaInfo.sub.width || null,
        height: mediaInfo.sub.height || null,
      };
    } catch (err) {
      console.error(`[session:${this.sessionId}][media] Download failed for`, msg.key.id, err.message);
      return {
        type: mediaInfo.type,
        mediaUrl: null,
        mimeType: mediaInfo.sub.mimetype || null,
        fileName: mediaInfo.sub.fileName || null,
        caption: mediaInfo.sub.caption || null,
        error: "download_failed",
      };
    }
  }

  // ─── Processar mensagem recebida ─────────────────────────────
  async onBaileysMessage(msg) {
    const jid = msg.key.remoteJid;
    if (!jid || jid === "status@broadcast") return;

    const msgObj = msg.message || {};
    const rawType = Object.keys(msgObj)[0] || "text";
    const text =
      msgObj.conversation ||
      msgObj.extendedTextMessage?.text ||
      msgObj.imageMessage?.caption ||
      msgObj.videoMessage?.caption ||
      "";

    let mediaData = null;
    if (this.detectMediaType(msg)) {
      mediaData = await this.downloadAndSaveMedia(msg);
    }

    const parsed = {
      id: msg.key.id,
      jid,
      fromMe: !!msg.key.fromMe,
      timestamp:
        typeof msg.messageTimestamp === "object"
          ? msg.messageTimestamp.low || 0
          : Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      type: mediaData?.type || (rawType.includes("text") || rawType === "conversation" ? "text" : rawType),
      pushName: msg.pushName || null,
      participant: msg.key.participant || null,
      text: text || mediaData?.caption || "",
      mediaUrl: mediaData?.mediaUrl || null,
      mimeType: mediaData?.mimeType || null,
      fileName: mediaData?.fileName || null,
      fileSize: mediaData?.fileSize || null,
      duration: mediaData?.duration || null,
      caption: mediaData?.caption || null,
    };

    if (!this.messagesMap.has(jid)) this.messagesMap.set(jid, []);
    const arr = this.messagesMap.get(jid);
    if (!arr.find((m) => m.id === parsed.id)) {
      arr.push(parsed);
      if (arr.length > 500) arr.splice(0, arr.length - 500);
    }

    this.recentMessages.push({ ...parsed, _ingestedAt: Date.now() });
    if (this.recentMessages.length > this.MAX_RECENT)
      this.recentMessages.splice(0, this.recentMessages.length - this.MAX_RECENT);

    const existing = this.chatsMap.get(jid) || {
      chatId: jid,
      displayName: "",
      lastMessageText: "",
      lastTimestamp: 0,
      unreadCount: 0,
    };
    if (parsed.timestamp >= existing.lastTimestamp) {
      existing.lastMessageText = (parsed.text || "").substring(0, 100);
      existing.lastTimestamp = parsed.timestamp;
    }
    if (!parsed.fromMe) existing.unreadCount++;
    if (msg.pushName && !existing.displayName) existing.displayName = msg.pushName;
    this.chatsMap.set(jid, existing);
  }

  // ─── Chamar automação (decide) ────────────────────────────────
  async callAutomationDecide(msg, text) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const ENGINE_KEY = process.env.ENGINE_AUTOMATION_KEY;
    if (!SUPABASE_URL || !ENGINE_KEY) return null;

    try {
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/automation-engine/${this.sessionId}/decide`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-engine-key": ENGINE_KEY,
          },
          body: JSON.stringify({
            contactJid: msg.key.remoteJid,
            inboundMessageId: msg.key.id,
            inboundText: text,
          }),
        }
      );
      if (!res.ok) {
        console.error(`[session:${this.sessionId}][automation] HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`[session:${this.sessionId}][automation] Error:`, err.message);
      return null;
    }
  }

  // ─── Executar decisão da automação ──────────────────────────
  async executeDecision(decision, contactJid) {
    if (!decision || !decision.shouldProcess) return;

    try {
      if (decision.action === "robot_reply") {
        await this.sendText(contactJid, decision.text);
        console.log(`[session:${this.sessionId}][automation] robot_reply sent to ${contactJid}`);

      } else if (decision.action === "funnel_start" || decision.action === "funnel_continue") {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const ENGINE_KEY = process.env.ENGINE_AUTOMATION_KEY;
        const stepRes = await fetch(
          `${SUPABASE_URL}/functions/v1/automation-engine/${this.sessionId}/funnels/${decision.funnelId}/steps/${decision.nextStepOrder}`,
          {
            headers: { "x-engine-key": ENGINE_KEY },
          }
        );
        if (stepRes.ok) {
          const step = await stepRes.json();
          if (step.delay_seconds > 0) {
            await new Promise(r => setTimeout(r, step.delay_seconds * 1000));
          }
          await this.sendText(contactJid, step.content);
          console.log(`[session:${this.sessionId}][automation] funnel step ${decision.nextStepOrder} sent`);
        }

      } else if (decision.action === "ai_reply" || decision.action === "ai_step") {
        const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
        if (!LOVABLE_API_KEY) {
          console.error(`[session:${this.sessionId}][automation] LOVABLE_API_KEY not set`);
          return;
        }
        const prompt = decision.action === "ai_reply" ? decision.prompt : (decision.aiInstruction || "Responda de forma profissional.");
        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${LOVABLE_API_KEY}`,
          },
          body: JSON.stringify({
            model: decision.model || "google/gemini-2.5-flash",
            messages: [{ role: "user", content: prompt }],
            max_tokens: decision.maxTokens || 700,
            temperature: decision.temperature || 0.7,
          }),
        });
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const reply = aiData.choices?.[0]?.message?.content;
          if (reply) {
            if (decision.delaySeconds > 0) {
              await new Promise(r => setTimeout(r, decision.delaySeconds * 1000));
            }
            await this.sendText(contactJid, reply);
            console.log(`[session:${this.sessionId}][automation] AI reply sent`);
          }
        }
      }
    } catch (err) {
      console.error(`[session:${this.sessionId}][automation] Execute error:`, err.message);
    }
  }

  // ─── Inicializar conexão Baileys ─────────────────────────────
  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    this.status.connection = "connecting";

    // Carregar proxy antes de criar o socket
    const agent = await this.buildProxyAgent();

    const socketConfig = {
      version,
      auth: state,
      printQRInTerminal: false,
    };

    // Se tem proxy, adicionar o agent ao socket
    if (agent) {
      socketConfig.agent = agent;
      socketConfig.fetchAgent = agent;
    }

    const socket = makeWASocket(socketConfig);

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status.hasQr = true;
        this.status.qr = qr;
      }

      if (connection) this.status.connection = connection;

      const code = lastDisconnect?.error?.output?.statusCode ?? null;
      this.status.lastDisconnectCode = code;

      if (connection === "open") {
        this.status.hasQr = false;
        this.status.qr = null;
        this.status.lastError = null;
        console.log(`[session:${this.sessionId}] WhatsApp conectado`);
      }

      if (connection === "close") {
        console.log(`[session:${this.sessionId}] Desconectou, código:`, code);

        if (code === DisconnectReason.loggedOut) {
          this.status.lastError = "logged_out";
          return;
        }

        setTimeout(() => this.connect(), 3000);
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages || []) {
        await this.onBaileysMessage(msg);

        if (!msg.key.fromMe && msg.key.remoteJid && msg.key.remoteJid !== "status@broadcast") {
          const msgObj = msg.message || {};
          const text =
            msgObj.conversation ||
            msgObj.extendedTextMessage?.text ||
            msgObj.imageMessage?.caption ||
            msgObj.videoMessage?.caption ||
            "";
          
          const decision = await this.callAutomationDecide(msg, text);
          if (decision) {
            await this.executeDecision(decision, msg.key.remoteJid);
          }
        }
      }
    });

    this.sock = socket;
    return socket;
  }

  // ─── Desconectar ─────────────────────────────────────────────
  async disconnect() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        try {
          this.sock.end();
        } catch {}
      }
      this.sock = null;
    }
    this.status.connection = "close";
  }

  // ─── Reiniciar (novo QR) ─────────────────────────────────────
  async restart() {
    await this.disconnect();

    if (fs.existsSync(this.authFolder)) {
      fs.rmSync(this.authFolder, { recursive: true, force: true });
      fs.mkdirSync(this.authFolder, { recursive: true });
    }

    this.status = {
      connection: "close",
      lastDisconnectCode: null,
      hasQr: false,
      qr: null,
      lastError: null,
    };

    await this.connect();
  }

  // ─── API helpers ─────────────────────────────────────────────
  getStatus() {
    return { ...this.status, hasSocket: !!this.sock };
  }

  listChats(limit = 30, cursor = null) {
    let chats = Array.from(this.chatsMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    if (cursor) {
      const cursorTs = parseInt(cursor);
      chats = chats.filter((c) => c.lastTimestamp < cursorTs);
    }

    const page = chats.slice(0, limit);
    const nextCursor = page.length === limit ? String(page[page.length - 1].lastTimestamp) : null;

    return { ok: true, chats: page, nextCursor, total: this.chatsMap.size };
  }

  listMessages(chatId, limit = 50, before = null) {
    const jidS = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    const jidG = chatId.includes("@") ? chatId : chatId + "@g.us";
    let msgs = this.messagesMap.get(jidS) || this.messagesMap.get(jidG) || this.messagesMap.get(chatId) || [];

    const beforeSec = before ? (before > 1e12 ? before / 1000 : before) : Date.now() / 1000;
    msgs = msgs
      .filter((m) => (m.timestamp || 0) < beforeSec)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return {
      ok: true,
      messages: msgs,
      hasMore: msgs.length === limit,
      nextCursor: msgs.length === limit ? String(msgs[msgs.length - 1].timestamp * 1000) : null,
      serverNow: Date.now(),
    };
  }

  getUpdates(afterMs = 0) {
    const afterSec = afterMs / 1000;
    const items = this.recentMessages.filter(
      (m) => (m.timestamp || 0) > afterSec || m._ingestedAt > afterMs
    );
    return { ok: true, items, serverNow: Date.now() };
  }

  async sendText(chatId, text) {
    if (!this.sock || this.status.connection !== "open") {
      throw new Error("WhatsApp not connected");
    }
    const jid = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    const sent = await this.sock.sendMessage(jid, { text });
    return { ok: true, id: sent.key.id };
  }

  async sendMedia(chatId, { type, buffer, mimetype, fileName, caption, ptt }) {
    if (!this.sock || this.status.connection !== "open") {
      throw new Error("WhatsApp not connected");
    }
    const jid = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    const payload = {};

    if (type === "image") payload.image = buffer;
    else if (type === "video") payload.video = buffer;
    else if (type === "audio") {
      payload.audio = buffer;
      payload.ptt = ptt !== false;
    } else if (type === "document") {
      payload.document = buffer;
      payload.fileName = fileName || "file";
    }

    if (mimetype) payload.mimetype = mimetype;
    if (caption) payload.caption = caption;

    const sent = await this.sock.sendMessage(jid, payload);
    return { ok: true, id: sent.key.id };
  }

  async getProfilePicture(chatId) {
    if (!this.sock) return { ok: false, url: null };
    const jid = chatId.includes("@") ? chatId : chatId + "@s.whatsapp.net";
    try {
      const url = await this.sock.profilePictureUrl(jid, "image");
      return { ok: true, url };
    } catch {
      return { ok: true, url: null };
    }
  }

  async getGroupMetadata(chatId) {
    if (!this.sock) throw new Error("Not connected");
    const jid = chatId.includes("@") ? chatId : chatId + "@g.us";
    const metadata = await this.sock.groupMetadata(jid);
    return {
      chatId: jid,
      subject: metadata.subject || null,
      participants: metadata.participants?.length || 0,
      owner: metadata.owner || null,
      creation: metadata.creation || null,
    };
  }

  async resolveGroupNames(chatIds) {
    const results = [];
    for (const id of chatIds.slice(0, 50)) {
      try {
        const jid = id.includes("@") ? id : id + "@g.us";
        const metadata = await this.sock.groupMetadata(jid);
        results.push({ chatId: jid, subject: metadata.subject || null, participants: metadata.participants?.length || 0 });
      } catch {
        results.push({ chatId: id, subject: null, error: "not_found" });
      }
    }
    return results;
  }
}

// ═══════════════════════════════════════════════════════════════
// SESSION MANAGER
// ═══════════════════════════════════════════════════════════════

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async getOrCreate(sessionId) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    console.log(`[SessionManager] Criando sessão: ${sessionId}`);
    const session = new WhatsAppSession(sessionId);
    this.sessions.set(sessionId, session);
    await session.connect();
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  async destroy(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    await session.disconnect();
    this.sessions.delete(sessionId);

    const authFolder = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(authFolder)) {
      fs.rmSync(authFolder, { recursive: true, force: true });
    }

    console.log(`[SessionManager] Sessão destruída: ${sessionId}`);
    return true;
  }

  listSessions() {
    const list = [];
    for (const [id, session] of this.sessions) {
      list.push({
        sessionId: id,
        connection: session.status.connection,
        hasQr: session.status.hasQr,
      });
    }
    return list;
  }

  async restoreFromDisk() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    console.log(`[SessionManager] Restaurando ${dirs.length} sessões do disco...`);

    for (const sessionId of dirs) {
      const authPath = path.join(SESSIONS_DIR, sessionId, "auth");
      if (fs.existsSync(authPath)) {
        try {
          await this.getOrCreate(sessionId);
          console.log(`[SessionManager] Sessão ${sessionId} restaurada`);
        } catch (err) {
          console.error(`[SessionManager] Falha ao restaurar ${sessionId}:`, err.message);
        }
      }
    }
  }
}

export const sessionManager = new SessionManager();
export { MEDIA_BASE_DIR };
