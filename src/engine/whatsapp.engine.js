// src/engine/whatsapp.engine.js
// ✅ VERSÃO FINAL — mídia + histórico + keep-alive
import * as baileys from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
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

// ─── Pasta de mídia ────────────────────────────────────────────
const MEDIA_DIR = process.env.MEDIA_DIR || "./media";
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const mediaDir = MEDIA_DIR;

// ─── Detectar tipo de mídia ────────────────────────────────────
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

// ─── Baixar e salvar mídia no disco ────────────────────────────
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

// ─── Limpeza automática de mídia (7 dias, a cada 6h) ──────────
setInterval(() => {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(MEDIA_DIR);
    for (const file of files) {
      const fp = path.join(MEDIA_DIR, file);
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}, 6 * 60 * 60 * 1000);

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

// ✅ Async para suportar download de mídia
async function upsertMessage(chatId, m) {
  const msgId = m.key?.id;
  if (!msgId) return;

  const arr = messagesMap.get(chatId) || [];

  // 🔒 Impede duplicação
  if (arr.find((x) => x.id === msgId)) {
    return;
  }

  // ✅ Detectar e baixar mídia
  let mediaData = null;
  if (detectMediaType(m)) {
    mediaData = await downloadAndSaveMedia(m);
  }

  const item = {
    id: msgId,
    fromMe: !!m.key?.fromMe,
    text: extractText(m.message) || mediaData?.caption || "",
    timestamp: Number(m.messageTimestamp || Date.now()),
    participant: m.key?.participant || null,
    type: mediaData?.type || "text",
    mediaUrl: mediaData?.mediaUrl || null,
    mimeType: mediaData?.mimeType || null,
    fileName: mediaData?.fileName || null,
    fileSize: mediaData?.fileSize || null,
    duration: mediaData?.duration || null,
    caption: mediaData?.caption || null
  };

  arr.push(item);

  if (arr.length > 500) {
    arr.splice(0, arr.length - 500);
  }

  messagesMap.set(chatId, arr);

  const existing = chatsMap.get(chatId) || { chatId, name: chatId };

  let preview = item.text;
  if (!preview && mediaData) {
    const icons = { image: "📷 Foto", video: "🎬 Vídeo", audio: "🎵 Áudio", document: "📎 Documento", sticker: "🖼️ Figurinha" };
    preview = icons[mediaData.type] || "Mídia";
  }

  chatsMap.set(chatId, {
    ...existing,
    chatId,
    lastMessage: preview || (item.fromMe ? "Mensagem enviada" : "Mensagem"),
    lastTimestamp: item.timestamp
  });
}

// ─── Inserção rápida de chat do histórico (sem mídia) ──────────
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
    ...existing
  });
}

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

export function getWhatsAppStatus() {
  return {
    ...status,
    hasSocket: !!sock
  };
}

export function getQrString() {
  return status.qr;
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
    out = out.filter((m) => Number(m.timestamp) < ts);
  }

  out = [...out].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return out.slice(0, Math.max(1, Number(limit) || 50));
}

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

  // ✅ KEEP-ALIVE: impede desconexão por inatividade
  // Envia presença "available" a cada 25 segundos
  setInterval(async () => {
    if (sock && status.connection === "open") {
      try {
        await sock.sendPresenceUpdate("available");
      } catch {}
    }
  }, 25000);

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

      setTimeout(() => {
        initWhatsApp();
      }, 1500);
    }
  });

  // ✅ HISTÓRICO: captura todas as conversas e mensagens do WhatsApp ao conectar
  sock.ev.on("messaging-history.set", async ({ chats, messages, isLatest }) => {
    console.log(`[history] Recebido: ${chats?.length || 0} conversas, ${messages?.length || 0} mensagens (isLatest: ${isLatest})`);

    if (chats && chats.length > 0) {
      for (const chat of chats) {
        upsertChatFromHistory(chat);
      }
      console.log(`[history] ${chats.length} conversas importadas. Total: ${chatsMap.size}`);
    }

    if (messages && messages.length > 0) {
      let count = 0;
      for (const m of messages) {
        const chatId = m.key?.remoteJid;
        if (!chatId || chatId === "status@broadcast") continue;
        try {
          await upsertMessage(chatId, m);
          count++;
        } catch (err) {
          console.error("[history] Erro ao importar msg:", m.key?.id, err.message);
        }
      }
      console.log(`[history] ${count} mensagens importadas`);
    }
  });

  // ✅ Novas conversas
  sock.ev.on("chats.upsert", (newChats) => {
    for (const chat of newChats) {
      upsertChatFromHistory(chat);
    }
  });

  // ✅ Atualizações de conversas (não lidas, pin, arquivo)
  sock.ev.on("chats.update", (updates) => {
    for (const update of updates) {
      const jid = update.id;
      if (!jid) continue;
      const existing = chatsMap.get(jid) || { chatId: jid, name: jid };
      if (update.unreadCount !== undefined) existing.unreadCount = update.unreadCount;
      if (update.archived !== undefined) existing.archived = update.archived;
      if (update.pinned !== undefined) existing.pinned = update.pinned;
      if (update.conversationTimestamp) {
        const ts = Number(update.conversationTimestamp);
        if (ts > (existing.lastTimestamp || 0)) existing.lastTimestamp = ts;
      }
      chatsMap.set(jid, existing);
    }
  });

  // ✅ Contatos (nomes da agenda)
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      const jid = c.id;
      if (!jid) continue;
      const existing = chatsMap.get(jid);
      if (existing && !existing.name && (c.name || c.notify)) {
        existing.name = c.name || c.notify;
        chatsMap.set(jid, existing);
      }
    }
  });

  // ✅ Mensagens em tempo real (com mídia)
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages || []) {
      const chatId = m.key?.remoteJid;
      if (!chatId) continue;
      await upsertMessage(chatId, m);
    }
  });

  return sock;
}
