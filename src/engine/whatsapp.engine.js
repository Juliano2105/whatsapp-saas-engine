// src/engine/whatsapp.engine.js

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

export async function initWhatsApp() {
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

    if (qr) {
      console.log("QR gerado, escaneie no WhatsApp");
    }

    if (connection === "open") {
      console.log("WhatsApp conectado");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("WhatsApp desconectou", statusCode || "");

      if (shouldReconnect) {
        initWhatsApp();
      } else {
        console.log("Deslogado do WhatsApp, precisa escanear novamente");
      }
    }
  });

  return sock;
}
