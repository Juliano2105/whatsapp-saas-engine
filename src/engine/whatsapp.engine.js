// src/engine/whatsapp.engine.js
import * as baileys from "@whiskeysockets/baileys";

const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } =
  baileys;

// Estado do motor
let sock = null;

const status = {
  connection: "close", // "connecting" | "open" | "close"
  lastDisconnectCode: null,
  hasQr: false,
  qr: null, // string do QR (para renderizar no /qr.png)
  hasSocket: false,
  lastError: null
};

// “Banco” em memória para UI
const chatsMap = new Map(); // chatId -> { chatId, name, lastMessage, lastTimestamp }
const messagesMap = new Map(); // chatId -> [ { id, fromMe, text, timestamp, participant } ]

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
  const msgId =
    m.key?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const item = {
    id: msgId,
    fromMe: !!m.key?.fromMe,
    text: extractText(m.message),
    timestamp: Number(m.messageTimestamp || Date.now()),
    participant: m.key?.participant || null
  };

  const arr = messagesMap.get(chatId) || [];
  arr.push(item);

  // limita histórico em memória para não explodir (ajuste se quiser)
  if (arr.length > 500) arr.splice(0, arr.length - 500);

  messagesMap.set(chatId, arr);

  const lastTimestamp = item.timestamp;
  const lastMessage = item.text || (item.fromMe ? "Mensagem enviada" : "Mensagem");

  const existing = chatsMap.get(chatId) || { chatId, name: chatId };
  chatsMap.set(chatId, {
    ...existing,
    chatId,
    lastMessage,
    lastTimestamp
  });
}

function safeJid(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  // já veio jid completo
  if (s.includes("@")) return s;

  // normaliza número (remove símbolos)
  const clean = s.replace(/\D/g, "");

  // regra do seu código antigo: se for 55 + DDD + 9 + 8 dígitos (13), remove o 9
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

export function getSock() {
  return sock;
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

  // registra também no nosso “store” em memória (para UI)
  upsertMessage(jid, {
    key: { id: result?.key?.id, fromMe: true, remoteJid: jid },
    message: { conversation: payload.text },
    messageTimestamp: Math.floor(Date.now() / 1000)
  });

  return result;
}

export async function initWhatsApp() {
  status.lastError = null;

  if (typeof makeWASocket !== "function") {
    status.lastError = "makeWASocket não é função";
    throw new Error("Baileys não expôs makeWASocket como função.");
  }

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
      console.log("✅ WhatsApp conectado.");
    }

    if (connection === "close") {
      console.log("❌ WhatsApp desconectou.", code || "");
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      if (!shouldReconnect) {
        status.lastError = "logged_out";
        return;
      }

      console.log("🔄 Reconectando...");
      setTimeout(() => initWhatsApp(), 1500);
    }
  });

  // captura mensagens e alimenta /chats e /messages
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages || []) {
      const chatId = m.key?.remoteJid;
      if (!chatId) continue;
      upsertMessage(chatId, m);
    }
  });

  return sock;
}
