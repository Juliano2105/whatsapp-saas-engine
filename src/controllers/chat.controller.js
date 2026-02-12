import { fetchChats } from "../services/chat.service.js"

export async function getChats(req, res, next) {
  try {
    const data = await fetchChats(req.query)
    res.json(data)
  } catch (err) {
    next(err)
  }
}
