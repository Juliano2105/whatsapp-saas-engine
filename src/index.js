// ═══════════════════════════════════════════════════════════════
// index.js — Servidor Express completo para Motor WhatsApp
// Caminho no Railway: src/index.js
// ═══════════════════════════════════════════════════════════════

import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import fs from "fs";

import {
  initWhatsApp,
  getWhatsAppStatus,
  getQrString,
  getSocket,
  listChats,
  listMessages,
  sendText,
  sendMedia,
  sendReply,
  sendPoll,
  markAsRead,
  sendPresence,
  getProfilePicture,
  sendReaction,
  deleteMessage,
  editMessage,
  forwardMessage,
  checkNumber,
  createGroup,
  addToGroup,
  removeFromGroup,
  promoteInGroup,
  demoteInGroup,
  getGroupInviteLink,
  revokeGroupInvite,
  updateGroupSubject,
  updateGroupDescription,
  setGroupMessagesAdminsOnly,
  leaveGroup,
  getGroupMetadata,
  resolveGroupNames,
  sendContact,
  sendLocation,
  blockContact,
  unblockContact,
  getAbout,
  updateMyProfile,
  updateMyProfilePicture,
  pinChat,
  archiveChat,
  muteChat,
  setEphemeral,
  getPresenceStore,
  getReceiptStore,
  getUpdates,
  mediaDir
} from "./engine/whatsapp.engine.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use("/media", express.static(mediaDir));

// ═══════════════════════════════════════════════════════════════
// 1. SAÚDE E STATUS
// ═══════════════════════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/status", (req, res) => {
  res.json(getWhatsAppStatus());
});

app.get("/qr.png", async (req, res) => {
  const qr = getQrString();
  if (!qr) return res.status(204).end();
  try {
    const buffer = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
    res.set("Content-Type", "image/png");
    res.send(buffer);
  } catch {
    res.status(500).json({ ok: false, error: "QR generation failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// 2. CONVERSAS
// ═══════════════════════════════════════════════════════════════

app.get("/chats", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const cursor = req.query.cursor || null;
  const all = listChats();

  let filtered = all;
  if (cursor) {
    const idx = all.findIndex(c => (c.lastTimestamp || 0) < Number(cursor));
    filtered = idx >= 0 ? all.slice(idx) : [];
  }

  const page = filtered.slice(0, limit);
  const nextCursor = page.length === limit ? page[page.length - 1]?.lastTimestamp : null;

  res.json({ ok: true, chats: page, nextCursor });
});

// ═══════════════════════════════════════════════════════════════
// 3. MENSAGENS
// ═══════════════════════════════════════════════════════════════

app.get("/messages", (req, res) => {
  const chatId = req.query.chat_id;
  if (!chatId) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });

  const limit = Number(req.query.limit) || 50;
  const before = req.query.before || null;
  const msgs = listMessages(chatId, limit, before);

  res.json({ ok: true, messages: msgs });
});

// ═══════════════════════════════════════════════════════════════
// 4. ENVIO DE MENSAGENS
// ═══════════════════════════════════════════════════════════════

app.post("/send", async (req, res) => {
  try {
    const { chat_id, text } = req.body;
    if (!chat_id || !text) return res.status(400).json({ ok: false, error: "chat_id e text obrigatórios" });
    const result = await sendText(chat_id, text);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/send-media", async (req, res) => {
  try {
    const { chat_id, type, base64, mimetype, fileName, caption, ptt } = req.body;
    if (!chat_id || !type || !base64) return res.status(400).json({ ok: false, error: "chat_id, type e base64 obrigatórios" });
    const buffer = Buffer.from(base64, "base64");
    const result = await sendMedia(chat_id, { type, buffer, mimetype, fileName, caption, ptt });
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/reply", async (req, res) => {
  try {
    const { chat_id, text, quoted_id } = req.body;
    if (!chat_id || !text || !quoted_id) return res.status(400).json({ ok: false, error: "chat_id, text e quoted_id obrigatórios" });
    const result = await sendReply(chat_id, text, quoted_id);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/send-poll", async (req, res) => {
  try {
    const { chat_id, name, options, multiSelect } = req.body;
    if (!chat_id || !name || !options?.length) return res.status(400).json({ ok: false, error: "chat_id, name e options obrigatórios" });
    const result = await sendPoll(chat_id, name, options, multiSelect);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/send-contact", async (req, res) => {
  try {
    const { chat_id, name, phone } = req.body;
    if (!chat_id || !name || !phone) return res.status(400).json({ ok: false, error: "chat_id, name e phone obrigatórios" });
    const result = await sendContact(chat_id, { name, phone });
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/send-location", async (req, res) => {
  try {
    const { chat_id, latitude, longitude, name, address } = req.body;
    if (!chat_id || !latitude || !longitude) return res.status(400).json({ ok: false, error: "chat_id, latitude e longitude obrigatórios" });
    const result = await sendLocation(chat_id, { latitude, longitude, name, address });
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 5. AÇÕES DE MENSAGEM
// ═══════════════════════════════════════════════════════════════

app.post("/read", async (req, res) => {
  try {
    const { chat_id, message_ids } = req.body;
    if (!chat_id || !message_ids) return res.status(400).json({ ok: false, error: "chat_id e message_ids obrigatórios" });
    await markAsRead(chat_id, message_ids);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/react", async (req, res) => {
  try {
    const { chat_id, message_id, emoji } = req.body;
    if (!chat_id || !message_id) return res.status(400).json({ ok: false, error: "chat_id e message_id obrigatórios" });
    await sendReaction(chat_id, message_id, emoji || "");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/delete-message", async (req, res) => {
  try {
    const { chat_id, message_id, from_me } = req.body;
    if (!chat_id || !message_id) return res.status(400).json({ ok: false, error: "chat_id e message_id obrigatórios" });
    await deleteMessage(chat_id, message_id, from_me !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/edit-message", async (req, res) => {
  try {
    const { chat_id, message_id, new_text } = req.body;
    if (!chat_id || !message_id || !new_text) return res.status(400).json({ ok: false, error: "chat_id, message_id e new_text obrigatórios" });
    const result = await editMessage(chat_id, message_id, new_text);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/forward", async (req, res) => {
  try {
    const { from_chat_id, to_chat_id, message_id } = req.body;
    if (!from_chat_id || !to_chat_id || !message_id) return res.status(400).json({ ok: false, error: "from_chat_id, to_chat_id e message_id obrigatórios" });
    const result = await forwardMessage(from_chat_id, to_chat_id, message_id);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 6. PRESENÇA E INDICADORES EM TEMPO REAL
// ═══════════════════════════════════════════════════════════════

app.post("/presence", async (req, res) => {
  try {
    const { chat_id, type } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await sendPresence(chat_id, type || "composing");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/presences", (req, res) => {
  const store = getPresenceStore();
  const chatId = req.query.chat_id;
  if (chatId) {
    res.json({ ok: true, presence: store[chatId] || null });
  } else {
    res.json({ ok: true, presences: store });
  }
});

app.get("/receipts", (req, res) => {
  const store = getReceiptStore();
  const chatId = req.query.chat_id;
  if (chatId) {
    res.json({ ok: true, receipts: store[chatId] || {} });
  } else {
    res.json({ ok: true, receipts: store });
  }
});

// ═══════════════════════════════════════════════════════════════
// 7. ORGANIZAÇÃO DE CONVERSAS
// ═══════════════════════════════════════════════════════════════

app.post("/pin", async (req, res) => {
  try {
    const { chat_id, pin } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await pinChat(chat_id, pin !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/archive", async (req, res) => {
  try {
    const { chat_id, archive } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await archiveChat(chat_id, archive !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/mute", async (req, res) => {
  try {
    const { chat_id, duration } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await muteChat(chat_id, duration || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/ephemeral", async (req, res) => {
  try {
    const { chat_id, duration } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await setEphemeral(chat_id, duration || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 8. PERFIL E CONTATOS
// ═══════════════════════════════════════════════════════════════

app.get("/profile-picture", async (req, res) => {
  try {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    const result = await getProfilePicture(chatId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/about", async (req, res) => {
  try {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    const result = await getAbout(chatId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/check-number", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ ok: false, error: "number obrigatório" });
    const result = await checkNumber(number);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/block", async (req, res) => {
  try {
    const { chat_id } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await blockContact(chat_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/unblock", async (req, res) => {
  try {
    const { chat_id } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await unblockContact(chat_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/update-profile", async (req, res) => {
  try {
    const { name, about } = req.body;
    const result = await updateMyProfile({ name, about });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/update-profile-picture", async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ ok: false, error: "base64 obrigatório" });
    const buffer = Buffer.from(base64, "base64");
    const result = await updateMyProfilePicture(buffer);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 9. GRUPOS
// ═══════════════════════════════════════════════════════════════

app.get("/groups/metadata", async (req, res) => {
  try {
    const chatId = req.query.chatId || req.query.chat_id;
    if (!chatId) return res.status(400).json({ ok: false, error: "chatId obrigatório" });
    const meta = await getGroupMetadata(chatId);
    res.json({ ok: true, ...meta });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/resolve", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ ok: false, error: "ids obrigatório" });
    const result = await resolveGroupNames(ids);
    res.json({ ok: true, groups: result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/create", async (req, res) => {
  try {
    const { name, participants } = req.body;
    if (!name || !participants?.length) return res.status(400).json({ ok: false, error: "name e participants obrigatórios" });
    const result = await createGroup(name, participants);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/add", async (req, res) => {
  try {
    const { group_id, participants } = req.body;
    const result = await addToGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/remove", async (req, res) => {
  try {
    const { group_id, participants } = req.body;
    const result = await removeFromGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/promote", async (req, res) => {
  try {
    const { group_id, participants } = req.body;
    const result = await promoteInGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/demote", async (req, res) => {
  try {
    const { group_id, participants } = req.body;
    const result = await demoteInGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/groups/invite-link", async (req, res) => {
  try {
    const groupId = req.query.group_id;
    if (!groupId) return res.status(400).json({ ok: false, error: "group_id obrigatório" });
    const result = await getGroupInviteLink(groupId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/revoke-invite", async (req, res) => {
  try {
    const { group_id } = req.body;
    const result = await revokeGroupInvite(group_id);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/update-subject", async (req, res) => {
  try {
    const { group_id, subject } = req.body;
    await updateGroupSubject(group_id, subject);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/update-description", async (req, res) => {
  try {
    const { group_id, description } = req.body;
    await updateGroupDescription(group_id, description);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/admins-only", async (req, res) => {
  try {
    const { group_id, admins_only } = req.body;
    await setGroupMessagesAdminsOnly(group_id, admins_only !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/groups/leave", async (req, res) => {
  try {
    const { group_id } = req.body;
    await leaveGroup(group_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 10. SINCRONIZAÇÃO E DELTA
// ═══════════════════════════════════════════════════════════════

app.get("/updates", (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(getUpdates(since));
});

// ═══════════════════════════════════════════════════════════════
// 11. REINICIAR SESSÃO
// ═══════════════════════════════════════════════════════════════

app.post("/restart", async (req, res) => {
  try {
    const sessionPath = process.env.SESSION_PATH || "./sessao_definitiva";
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    await initWhatsApp();
    res.json({ ok: true, message: "Sessão reiniciada, novo QR será gerado" });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

initWhatsApp()
  .then(() => console.log("WhatsApp engine started"))
  .catch((err) => console.error("WhatsApp engine error:", err));

app.listen(PORT, () => {
  console.log(`Motor rodando na porta ${PORT}`);
});
