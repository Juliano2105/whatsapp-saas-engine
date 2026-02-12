// src/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";

import { initWhatsApp, getWhatsAppStatus, getLastQr } from "./engine/whatsapp.engine.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).send("OK whatsapp saas engine online");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/status", (req, res) => {
  res.status(200).json(getWhatsAppStatus());
});

app.get("/qr", (req, res) => {
  const qr = getLastQr();
  if (!qr) return res.status(404).json({ ok: false, error: "QR ainda não foi gerado" });
  res.status(200).json({ ok: true, qr });
});

app.get("/qr.png", async (req, res) => {
  try {
    const qr = getLastQr();
    if (!qr) return res.status(404).send("QR ainda não foi gerado");

    const pngBuffer = await QRCode.toBuffer(qr, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 8
    });

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(pngBuffer);
  } catch (e) {
    res.status(500).send(e?.message || "Erro ao gerar QR");
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
