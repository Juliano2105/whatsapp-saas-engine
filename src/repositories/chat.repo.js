import { supabase } from "../config/supabase.js"

export async function getChatsFromDB(limit, cursor) {
  let query = supabase
    .from("chats")
    .select("*")
    .order("last_timestamp", { ascending: false })
    .limit(limit)

  if (cursor) {
    query = query.lt("last_timestamp", cursor)
  }

  const { data, error } = await query
  if (error) throw error

  return data
}
