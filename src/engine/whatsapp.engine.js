// src/engine/whatsapp.engine.js
import * as baileys from "@whiskeysockets/baileys";

const makeWASocket = baileys.default || baileys.makeWASocket;

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

let sockRef = null;
let lastQr = null;
let lastConnection = "idle";
let lastDisconnectCode = null;
let lastError = null;

export function getWhatsAppStatus() {
  return {
    connection: lastConnection,
    lastDisconnectCode,
    hasQr: Boolean(lastQr),
    qr: lastQr,
    hasSocket: Boolean(sockRef),
    lastError: lastError ? String(lastError?.message || lastError) : null
  };
}

export function getLastQr() {
  return lastQr;
}

export async function initWhatsApp() {
  if (typeof makeWASocket !== "function") {
    throw new Error("Baileys não expôs makeWASocket como função.");
  }

  const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true
  });

  sockRef = sock;
  lastError = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQr = qr;
      console.log("📲 QR gerado. Abra /qr.png para escanear.");
    }

    if (connection) {
      lastConnection = connection;
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado.");
      lastQr = null;
      lastDisconnectCode = null;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode || null;
      lastDisconnectCode = statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("❌ WhatsApp desconectou.", statusCode || "");

      if (shouldReconnect) {
        console.log("🔄 Reconectando...");
        initWhatsApp().catch((e) => {
          lastError = e;
          console.error("Erro ao reconectar:", e?.message || e);
        });
      }
    }
  });

  return sock;
}
