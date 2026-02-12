import { getMessagesFromDB } from "../repositories/message.repo.js"

export async function fetchMessages({ chat_id, limit = 50, cursor }) {
  if (!chat_id) return []
  return await getMessagesFromDB(chat_id, Number(limit), cursor)
}
