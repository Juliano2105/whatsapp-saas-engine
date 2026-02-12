import { fetchMessages } from "../services/message.service.js"

export async function getMessages(req, res, next) {
  try {
    const data = await fetchMessages(req.query)
    res.json(data)
  } catch (err) {
    next(err)
  }
}
