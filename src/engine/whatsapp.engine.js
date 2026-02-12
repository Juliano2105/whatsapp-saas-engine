// src/engine/whatsapp.engine.js

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

let sockGlobal = null;
let isInitializing = false;

export async function initWhatsApp() {
  if (isInitializing) return sockGlobal;
  isInitializing = true;

  try {
    const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: true
    });

    sockGlobal = sock;

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
          console.log("🔄 Reconectando em 3s...");
          setTimeout(() => {
            initWhatsApp().catch((e) => console.error("Erro ao reconectar:", e));
          }, 3000);
        }
      }
    });

    return sock;
  } finally {
    isInitializing = false;
  }
}
