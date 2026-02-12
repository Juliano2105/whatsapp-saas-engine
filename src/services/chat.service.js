import { getChatsFromDB } from "../repositories/chat.repo.js"

export async function fetchChats({ limit = 30, cursor }) {
  return await getChatsFromDB(Number(limit), cursor)
}
