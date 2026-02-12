// src/engine/whatsapp.engine.js

import * as baileys from "@whiskeysockets/baileys";

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

export async function initWhatsApp() {
  if (typeof makeWASocket !== "function") {
    throw new Error(
      "Baileys não expôs makeWASocket como função. Verifique a versão instalada e o build."
    );
  }

  const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) console.log("📲 QR gerado. Escaneie no WhatsApp.");

    if (connection === "open") console.log("✅ WhatsApp conectado.");

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("❌ WhatsApp desconectou.", statusCode || "");

      if (shouldReconnect) {
        console.log("🔄 Reconectando...");
        initWhatsApp();
      }
    }
  });

  return sock;
}
