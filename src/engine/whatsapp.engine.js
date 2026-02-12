import * as baileys from "@whiskeysockets/baileys";

const makeWASocket = baileys.default || baileys.makeWASocket;

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

let sockGlobal = null;
let lastQrGlobal = null;

let connectionGlobal = "starting";
let lastDisconnectCodeGlobal = null;
let lastErrorGlobal = null;

export function getWhatsAppStatus() {
  return {
    connection: connectionGlobal,
    lastDisconnectCode: lastDisconnectCodeGlobal,
    hasQr: Boolean(lastQrGlobal),
    qr: lastQrGlobal || null,
    hasSocket: Boolean(sockGlobal),
    lastError: lastErrorGlobal
  };
}

export async function initWhatsApp() {
  if (typeof makeWASocket !== "function") {
    connectionGlobal = "error";
    lastErrorGlobal = "makeWASocket not available";
    throw new Error("Baileys não expôs makeWASocket como função");
  }

  const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  connectionGlobal = "connecting";
  lastErrorGlobal = null;

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true
  });

  sockGlobal = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQrGlobal = qr;
      console.log("QR gerado escaneie no WhatsApp");
    }

    if (connection) connectionGlobal = connection;

    if (connection === "open") {
      console.log("WhatsApp conectado");
      lastQrGlobal = null;
      lastDisconnectCodeGlobal = null;
      lastErrorGlobal = null;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode || null;
      lastDisconnectCodeGlobal = statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("WhatsApp desconectou", statusCode || "");

      if (shouldReconnect) {
        connectionGlobal = "reconnecting";
        setTimeout(() => {
          initWhatsApp().catch((e) => {
            lastErrorGlobal = e?.message || String(e);
            console.error("Falha ao reconectar", lastErrorGlobal);
          });
        }, 1500);
      } else {
        connectionGlobal = "logged_out";
      }
    }
  });

  return sock;
}
