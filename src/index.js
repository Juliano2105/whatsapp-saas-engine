import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { initWhatsApp, getWhatsAppStatus } from "./engine/whatsapp.engine.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).send("OK whatsapp saas engine online");
});

app.get("/status", (req, res) => {
  const status = getWhatsAppStatus();
  res.status(200).json(status);
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
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
