// src/index.js
// ✅ VERSÃO FINAL — Motor WhatsApp SaaS Profissional
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

import {
  initWhatsApp,
  getWhatsAppStatus,
  getQrString,
  listChats,
  listMessages,
  sendText,
  mediaDir
} from "./engine/whatsapp.engine.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ✅ Servir arquivos de mídia (fotos, vídeos, áudios)
app.use("/media", express.static(mediaDir));

// ─── Root ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    name: "WhatsApp SaaS Engine",
    version: "2.0.0",
    status: getWhatsAppStatus().connection,
    uptime: Math.floor(process.uptime()),
    endpoints: [
      "GET /health",
      "GET /status",
      "GET /qr.png",
      "GET /chats",
      "GET /messages?chat_id=&limit=&before=",
      "GET /updates?after=",
      "POST /send",
      "POST /restart",
      "GET /groups/metadata?chatId=",
      "POST /groups/resolve",
      "GET /media/:filename",
      "GET /media/download/:messageId"
    ]
  });
});

// ─── Health ────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, uptime: Math.floor(process.uptime()) });
});

// ─── Status (conexão + QR) ────────────────────────────────────
app.get("/status", (req, res) => {
  const s = getWhatsAppStatus();
  res.status(200).json({
    ...s,
    qr: s.qr || null
  });
});

// ─── QR como imagem PNG ───────────────────────────────────────
app.get("/qr.png", async (req, res) => {
  const qr = getQrString();
  if (!qr) {
    return res.status(404).json({ ok: false, error: "no_qr" });
  }
  try {
    const pngBuffer = await QRCode.toBuffer(qr, {
      type: "png",
      width: 520,
      margin: 2
    });
    res.setHeader("Content-Type", "image/png");
    res.status(200).send(pngBuffer);
  } catch (e) {
    res.status(500).json({ ok: false, error: "qr_render_failed" });
  }
});

// ─── Lista de conversas (paginada) ────────────────────────────
app.get("/chats", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const cursor = req.query.cursor || null;

  let chats = listChats();

  // Paginação por cursor (timestamp)
  if (cursor) {
    const cursorTs = parseInt(cursor);
    chats = chats.filter((c) => (c.lastTimestamp || 0) < cursorTs);
  }

  const page = chats.slice(0, limit);
  const nextCursor =
    page.length === limit
      ? String(page[page.length - 1]?.lastTimestamp || 0)
      : null;

  res.status(200).json({
    ok: true,
    chats: page,
    nextCursor,
    total: listChats().length
  });
});

// ─── Mensagens de um chat ─────────────────────────────────────
app.get("/messages", (req, res) => {
  const chatId = String(req.query.chat_id || "");
  if (!chatId) {
    return res.status(400).json({ ok: false, error: "missing_chat_id" });
  }

  const limit = Math.min(Number(req.query.limit || 50), 200);
  const before = req.query.before || null;

  const messages = listMessages(chatId, limit, before);
  const hasMore = messages.length === limit;

  res.status(200).json({
    ok: true,
    chat_id: chatId,
    items: messages,
    messages, // compatibilidade
    hasMore,
    nextCursor: hasMore
      ? String((messages[messages.length - 1]?.timestamp || 0) * 1000)
      : null,
    serverNow: Date.now()
  });
});

// ─── Updates (delta sync) ─────────────────────────────────────
app.get("/updates", (req, res) => {
  const afterMs = parseInt(req.query.after) || 0;
  const afterSec = afterMs / 1000;

  // Pegar todas as mensagens de todos os chats após o timestamp
  const allMessages = [];
  const chats = listChats();

  for (const chat of chats) {
    const msgs = listMessages(chat.chatId, 500);
    for (const m of msgs) {
      if ((m.timestamp || 0) > afterSec) {
        allMessages.push({ ...m, jid: chat.chatId });
      }
    }
  }

  // Ordenar por timestamp
  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  res.status(200).json({
    ok: true,
    items: allMessages.slice(0, 500),
    serverNow: Date.now()
  });
});

// ─── Enviar mensagem ──────────────────────────────────────────
app.post("/send", async (req, res) => {
  try {
    const chatId = req.body?.chat_id;
    const text = req.body?.text;

    if (!chatId || typeof text !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "chat_id_and_text_required" });
    }

    const result = await sendText(chatId, text);
    res.status(200).json({ ok: true, id: result?.key?.id, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

// ─── Reiniciar sessão (novo QR) ──────────────────────────────
app.post("/restart", async (req, res) => {
  try {
    const status = getWhatsAppStatus();

    // Limpar sessão
    const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("[restart] Sessão removida");
    }

    // Reiniciar
    await initWhatsApp();
    res.status(200).json({
      ok: true,
      message: "Sessão reiniciada. Aguarde o QR em /status."
    });
  } catch (err) {
    console.error("[restart] Erro:", err);
    res.status(500).json({ ok: false, error: err?.message || "restart_failed" });
  }
});

// ─── Metadados de grupo ───────────────────────────────────────
app.get("/groups/metadata", async (req, res) => {
  const chatId = req.query.chatId;
  if (!chatId) {
    return res.status(400).json({ ok: false, error: "chatId required" });
  }

  try {
    // Importar sock dinamicamente do engine
    const { getSocket } = await import("./engine/whatsapp.engine.js");
    const sock = getSocket ? getSocket() : null;

    if (!sock) {
      return res.status(503).json({ ok: false, error: "socket_not_ready" });
    }

    const jid = chatId.includes("@") ? chatId : chatId + "@g.us";
    const metadata = await sock.groupMetadata(jid);

    res.status(200).json({
      ok: true,
      chatId: jid,
      subject: metadata.subject || null,
      desc: metadata.desc || null,
      participants: metadata.participants || [],
      participantCount: metadata.participants?.length || 0,
      owner: metadata.owner || null,
      creation: metadata.creation || null
    });
  } catch (err) {
    res.status(404).json({ ok: false, error: "group_not_found" });
  }
});

// ─── Resolver nomes de grupos em lote ─────────────────────────
app.post("/groups/resolve", async (req, res) => {
  const { chatIds } = req.body || {};
  if (!Array.isArray(chatIds)) {
    return res.status(400).json({ ok: false, error: "chatIds array required" });
  }

  try {
    const { getSocket } = await import("./engine/whatsapp.engine.js");
    const sock = getSocket ? getSocket() : null;

    if (!sock) {
      return res.status(503).json({ ok: false, error: "socket_not_ready" });
    }

    const results = [];
    for (const id of chatIds.slice(0, 50)) {
      try {
        const jid = id.includes("@") ? id : id + "@g.us";
        const metadata = await sock.groupMetadata(jid);
        results.push({
          chatId: jid,
          subject: metadata.subject || null,
          participants: metadata.participants?.length || 0
        });
      } catch {
        results.push({ chatId: id, subject: null, error: "not_found" });
      }
    }

    res.status(200).json({ ok: true, items: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

// ─── Download de mídia por messageId ──────────────────────────
app.get("/media/download/:messageId", (req, res) => {
  const { messageId } = req.params;
  try {
    const files = fs
      .readdirSync(mediaDir)
      .filter((f) => f.startsWith(messageId));
    if (files.length > 0) {
      return res.sendFile(path.resolve(mediaDir, files[0]));
    }
  } catch {}
  res.status(404).json({ ok: false, error: "media_not_found" });
});

// ─── Iniciar servidor ─────────────────────────────────────────
const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, async () => {
  console.log(`[server] Rodando na porta ${PORT}`);
  try {
    await initWhatsApp();
  } catch (err) {
    console.error("[server] Falha ao iniciar WhatsApp:", err?.message || err);
  }
});
