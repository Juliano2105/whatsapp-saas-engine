import express from "express"
import cors from "cors"
import dotenv from "dotenv"

import chatRoutes from "./routes/chat.routes.js"
import messageRoutes from "./routes/message.routes.js"
import statusRoutes from "./routes/status.routes.js"
import { initWhatsApp } from "./engine/whatsapp.engine.js"
import { errorHandler } from "./middleware/error.middleware.js"

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())

app.use("/status", statusRoutes)
app.use("/chats", chatRoutes)
app.use("/messages", messageRoutes)

app.use(errorHandler)

const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
  console.log("Servidor rodando na porta", PORT)
  await initWhatsApp()
})
