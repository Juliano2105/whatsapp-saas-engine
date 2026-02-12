import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import { supabase } from "../config/supabase.js"
import { runAutomationForMessage } from "./automation.engine.js"

export async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(
    process.env.SESSION_PATH || "./sessao_definitiva"
  )

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    global.connectionStatus = update
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key?.remoteJid) continue

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ""

      const payload = {
        message_id: msg.key.id,
        chat_id: msg.key.remoteJid,
        from_me: !!msg.key.fromMe,
        text,
        timestamp: Number(msg.messageTimestamp) * 1000
      }

      await supabase.from("messages").upsert(payload)
      await runAutomationForMessage(payload)
    }
  })
}
