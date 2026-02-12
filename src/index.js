// src/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";

import {
  initWhatsApp,
  getWhatsAppStatus,
  getQrString,
  listChats,
  listMessages,
  sendText
} from "./engine/whatsapp.engine.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Root simples (para não dar Cannot GET /)
app.get("/", (req, res) => {
  res.status(200).send("OK whatsapp saas engine online");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/status", (req, res) => {
  res.status(200).json(getWhatsAppStatus());
});

// QR como imagem PNG
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

// Lista chats (UI)
app.get("/chats", (req, res) => {
  res.status(200).json({ ok: true, chats: listChats() });
});

// Lista mensagens por chat
// /messages?chat_id=55DDDNUM@s.whatsapp.net&limit=50&before=TIMESTAMP
app.get("/messages", (req, res) => {
  const chatId = String(req.query.chat_id || "");
  if (!chatId) {
    return res.status(400).json({ ok: false, error: "missing_chat_id" });
  }

  const limit = Number(req.query.limit || 50);
  const before = req.query.before || null;

  res.status(200).json({
    ok: true,
    chat_id: chatId,
    messages: listMessages(chatId, limit, before)
  });
});

// Envio de mensagem
// POST /send { "chat_id": "...", "text": "..." }
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
    res.status(200).json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, async () => {
  console.log("Servidor rodando na porta", PORT);
  try {
    await initWhatsApp();
  } catch (err) {
    console.error("Falha ao iniciar WhatsApp", err?.message || err);
  }
});
