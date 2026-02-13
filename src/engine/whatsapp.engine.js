// src/engine/whatsapp.engine.js
import * as baileys from "@whiskeysockets/baileys";

const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } =
  baileys;

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

function upsertMessage(chatId, m) {
  const msgId = m.key?.id;
  if (!msgId) return;

  const arr = messagesMap.get(chatId) || [];

  // 🔒 Impede duplicação
  if (arr.find((x) => x.id === msgId)) {
    return;
  }

  const item = {
    id: msgId,
    fromMe: !!m.key?.fromMe,
    text: extractText(m.message),
    timestamp: Number(m.messageTimestamp || Date.now()),
    participant: m.key?.participant || null
  };

  arr.push(item);

  if (arr.length > 500) {
    arr.splice(0, arr.length - 500);
  }

  messagesMap.set(chatId, arr);

  const existing = chatsMap.get(chatId) || { chatId, name: chatId };

  chatsMap.set(chatId, {
    ...existing,
    chatId,
    lastMessage: item.text || (item.fromMe ? "Mensagem enviada" : "Mensagem"),
    lastTimestamp: item.timestamp
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

  upsertMessage(jid, {
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

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages || []) {
      const chatId = m.key?.remoteJid;
      if (!chatId) continue;
      upsertMessage(chatId, m);
    }
  });

  return sock;
}
