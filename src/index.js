// ═══════════════════════════════════════════════════════════════
// index.js — Servidor Express Multi-Sessão WhatsApp
// ✅ VERSÃO COMPLETA MULTI-TENANT
// ═══════════════════════════════════════════════════════════════

import express from "express";
import cors from "cors";
import fs from "fs";
import QRCode from "qrcode";
import { sessionManager, MEDIA_BASE_DIR } from "./engine/session-manager.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/media", express.static(MEDIA_BASE_DIR));

async function getSession(req, res) {
  const { sessionId } = req.params;
  if (!sessionId) { res.status(400).json({ ok: false, error: "sessionId obrigatório" }); return null; }
  const session = sessionManager.get(sessionId);
  if (!session) { res.status(404).json({ ok: false, error: `Sessão "${sessionId}" não encontrada.` }); return null; }
  return session;
}

// ═══════════════════════════════════════════════════════════════
// GESTÃO DE SESSÕES
// ═══════════════════════════════════════════════════════════════

app.post("/sessions/create", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId obrigatório" });
    const existing = sessionManager.get(sessionId);
    if (existing) return res.json({ ok: true, status: existing.getStatus(), created: false });
    const session = await sessionManager.getOrCreate(sessionId);
    res.json({ ok: true, status: session.getStatus(), created: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/sessions", (req, res) => {
  res.json({ ok: true, sessions: sessionManager.listSessions() });
});

app.delete("/sessions/:sessionId", async (req, res) => {
  try {
    const ok = await sessionManager.destroy(req.params.sessionId);
    res.json({ ok });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 1. SAÚDE E STATUS
// ═══════════════════════════════════════════════════════════════

app.get("/:sessionId/health", (req, res) => {
  const session = sessionManager.get(req.params.sessionId);
  res.json({ ok: !!session, uptime: process.uptime() });
});

app.get("/:sessionId/status", async (req, res) => {
  const session = sessionManager.get(req.params.sessionId)
    || await sessionManager.getOrCreate(req.params.sessionId);
  res.json(session.getStatus());
});

app.get("/:sessionId/qr.png", async (req, res) => {
  const session = sessionManager.get(req.params.sessionId);
  if (!session) return res.status(404).end();
  const qr = session.status.qr;
  if (!qr) return res.status(204).end();
  try {
    const buffer = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
    res.set("Content-Type", "image/png");
    res.send(buffer);
  } catch { res.status(500).json({ ok: false, error: "QR generation failed" }); }
});

// ═══════════════════════════════════════════════════════════════
// 2. CONVERSAS
// ═══════════════════════════════════════════════════════════════

app.get("/:sessionId/chats", async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const limit = Number(req.query.limit) || 50;
  const cursor = req.query.cursor || null;
  res.json(session.listChats(limit, cursor));
});

// ═══════════════════════════════════════════════════════════════
// 3. MENSAGENS
// ═══════════════════════════════════════════════════════════════

app.get("/:sessionId/messages", async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  const chatId = req.query.chat_id;
  if (!chatId) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
  const limit = Number(req.query.limit) || 50;
  const before = req.query.before || null;
  res.json(session.listMessages(chatId, limit, before));
});

// ═══════════════════════════════════════════════════════════════
// 4. ENVIO DE MENSAGENS
// ═══════════════════════════════════════════════════════════════

app.post("/:sessionId/send", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, text } = req.body;
    if (!chat_id || !text) return res.status(400).json({ ok: false, error: "chat_id e text obrigatórios" });
    const result = await session.sendText(chat_id, text);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/send-media", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, type, base64, mimetype, fileName, caption, ptt } = req.body;
    if (!chat_id || !type || !base64) return res.status(400).json({ ok: false, error: "chat_id, type e base64 obrigatórios" });
    const buffer = Buffer.from(base64, "base64");
    const result = await session.sendMedia(chat_id, { type, buffer, mimetype, fileName, caption, ptt });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/reply", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, text, quoted_id } = req.body;
    if (!chat_id || !text || !quoted_id) return res.status(400).json({ ok: false, error: "chat_id, text e quoted_id obrigatórios" });
    const result = await session.sendReply(chat_id, text, quoted_id);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/send-poll", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, name, options, multiSelect } = req.body;
    if (!chat_id || !name || !options?.length) return res.status(400).json({ ok: false, error: "chat_id, name e options obrigatórios" });
    const result = await session.sendPoll(chat_id, name, options, multiSelect);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/send-contact", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, name, phone } = req.body;
    if (!chat_id || !name || !phone) return res.status(400).json({ ok: false, error: "chat_id, name e phone obrigatórios" });
    const result = await session.sendContact(chat_id, { name, phone });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/send-location", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, latitude, longitude, name, address } = req.body;
    if (!chat_id || !latitude || !longitude) return res.status(400).json({ ok: false, error: "chat_id, latitude e longitude obrigatórios" });
    const result = await session.sendLocation(chat_id, { latitude, longitude, name, address });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 5. AÇÕES DE MENSAGEM
// ═══════════════════════════════════════════════════════════════

app.post("/:sessionId/read", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, message_ids } = req.body;
    if (!chat_id || !message_ids) return res.status(400).json({ ok: false, error: "chat_id e message_ids obrigatórios" });
    await session.markAsRead(chat_id, message_ids);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/react", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, message_id, emoji } = req.body;
    if (!chat_id || !message_id) return res.status(400).json({ ok: false, error: "chat_id e message_id obrigatórios" });
    await session.sendReaction(chat_id, message_id, emoji || "");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/delete-message", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, message_id, from_me } = req.body;
    if (!chat_id || !message_id) return res.status(400).json({ ok: false, error: "chat_id e message_id obrigatórios" });
    await session.deleteMessage(chat_id, message_id, from_me !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/edit-message", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, message_id, new_text } = req.body;
    if (!chat_id || !message_id || !new_text) return res.status(400).json({ ok: false, error: "chat_id, message_id e new_text obrigatórios" });
    const result = await session.editMessage(chat_id, message_id, new_text);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/forward", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { from_chat_id, to_chat_id, message_id } = req.body;
    if (!from_chat_id || !to_chat_id || !message_id) return res.status(400).json({ ok: false, error: "from_chat_id, to_chat_id e message_id obrigatórios" });
    const result = await session.forwardMessage(from_chat_id, to_chat_id, message_id);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 6. PRESENÇA E INDICADORES EM TEMPO REAL
// ═══════════════════════════════════════════════════════════════

app.post("/:sessionId/presence", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, type } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.sendPresence(chat_id, type || "composing");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/:sessionId/presences", (req, res) => {
  const session = sessionManager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false });
  const store = session.getPresenceStore();
  const chatId = req.query.chat_id;
  if (chatId) { res.json({ ok: true, presence: store[chatId] || null }); }
  else { res.json({ ok: true, presences: store }); }
});

app.get("/:sessionId/receipts", (req, res) => {
  const session = sessionManager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false });
  const store = session.getReceiptStore();
  const chatId = req.query.chat_id;
  if (chatId) { res.json({ ok: true, receipts: store[chatId] || {} }); }
  else { res.json({ ok: true, receipts: store }); }
});

// ═══════════════════════════════════════════════════════════════
// 7. ORGANIZAÇÃO DE CONVERSAS
// ═══════════════════════════════════════════════════════════════

app.post("/:sessionId/pin", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, pin } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.pinChat(chat_id, pin !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/archive", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, archive } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.archiveChat(chat_id, archive !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/mute", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, duration } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.muteChat(chat_id, duration || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/ephemeral", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id, duration } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.setEphemeral(chat_id, duration || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 8. PERFIL E CONTATOS
// ═══════════════════════════════════════════════════════════════

app.get("/:sessionId/profile-picture", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    const result = await session.getProfilePicture(chatId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/:sessionId/about", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    const result = await session.getAbout(chatId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/:sessionId/check-number", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ ok: false, error: "number obrigatório" });
    const result = await session.checkNumber(number);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/block", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.blockContact(chat_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/unblock", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { chat_id } = req.body;
    if (!chat_id) return res.status(400).json({ ok: false, error: "chat_id obrigatório" });
    await session.unblockContact(chat_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/update-profile", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { name, about } = req.body;
    const result = await session.updateMyProfile({ name, about });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/update-profile-picture", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ ok: false, error: "base64 obrigatório" });
    const buffer = Buffer.from(base64, "base64");
    const result = await session.updateMyProfilePicture(buffer);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 9. GRUPOS
// ═══════════════════════════════════════════════════════════════

app.get("/:sessionId/groups/metadata", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const chatId = req.query.chatId || req.query.chat_id;
    if (!chatId) return res.status(400).json({ ok: false, error: "chatId obrigatório" });
    const meta = await session.getGroupMetadata(chatId);
    res.json({ ok: true, ...meta });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/resolve", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { ids, chatIds } = req.body;
    const idList = ids || chatIds;
    if (!idList?.length) return res.status(400).json({ ok: false, error: "ids obrigatório" });
    const result = await session.resolveGroupNames(idList);
    res.json({ ok: true, groups: result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/create", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { name, participants } = req.body;
    if (!name || !participants?.length) return res.status(400).json({ ok: false, error: "name e participants obrigatórios" });
    const result = await session.createGroup(name, participants);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/add", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, participants } = req.body;
    const result = await session.addToGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/remove", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, participants } = req.body;
    const result = await session.removeFromGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/promote", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, participants } = req.body;
    const result = await session.promoteInGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/demote", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, participants } = req.body;
    const result = await session.demoteInGroup(group_id, participants);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/:sessionId/groups/invite-link", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const groupId = req.query.group_id;
    if (!groupId) return res.status(400).json({ ok: false, error: "group_id obrigatório" });
    const result = await session.getGroupInviteLink(groupId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/revoke-invite", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id } = req.body;
    const result = await session.revokeGroupInvite(group_id);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/update-subject", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, subject } = req.body;
    await session.updateGroupSubject(group_id, subject);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/update-description", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, description } = req.body;
    await session.updateGroupDescription(group_id, description);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/admins-only", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id, admins_only } = req.body;
    await session.setGroupMessagesAdminsOnly(group_id, admins_only !== false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post("/:sessionId/groups/leave", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    const { group_id } = req.body;
    await session.leaveGroup(group_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 10. SINCRONIZAÇÃO E DELTA
// ═══════════════════════════════════════════════════════════════

app.get("/:sessionId/updates", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  const since = Number(req.query.since) || 0;
  res.json(session.getUpdates(since));
});

// ═══════════════════════════════════════════════════════════════
// 11. REINICIAR SESSÃO
// ═══════════════════════════════════════════════════════════════

app.post("/:sessionId/restart", async (req, res) => {
  const session = await getSession(req, res); if (!session) return;
  try {
    await session.restart();
    res.json({ ok: true, message: "Sessão reiniciada, novo QR será gerado" });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/:sessionId/capabilities", (req, res) => {
  res.json({
    favorites_supported: true,
    forward_supported: true,
    read_receipts_supported: true,
    theme_supported: true,
    notifications_show_preview: true,
  });
});

// ─── Limpeza de mídia (7 dias, a cada 6h) ───
setInterval(() => {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  try {
    const dirs = fs.readdirSync(MEDIA_BASE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const dir of dirs) {
      const dirPath = `${MEDIA_BASE_DIR}/${dir}`;
      for (const file of fs.readdirSync(dirPath)) {
        const fp = `${dirPath}/${file}`;
        try {
          if (Date.now() - fs.statSync(fp).mtimeMs > maxAge) fs.unlinkSync(fp);
        } catch {}
      }
    }
  } catch {}
}, 6 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

sessionManager.restoreFromDisk()
  .then(() => console.log("[SessionManager] Sessões restauradas"))
  .catch((err) => console.error("[SessionManager] Erro ao restaurar:", err));

app.listen(PORT, () => {
  console.log(`[multi-session] Motor multi-sessão rodando na porta ${PORT}`);
  console.log(`[multi-session] Endpoints: /:sessionId/status, /:sessionId/chats, etc.`);
});
