import { supabase } from "../config/supabase.js"

export async function getMessagesFromDB(chatId, limit, cursor) {
  let query = supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("timestamp", { ascending: false })
    .limit(limit)

  if (cursor) {
    query = query.lt("timestamp", cursor)
  }

  const { data, error } = await query
  if (error) throw error

  return data
}
