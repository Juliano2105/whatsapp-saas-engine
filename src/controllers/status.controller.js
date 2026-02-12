export async function getStatus(req, res) {
  res.json(global.connectionStatus || { status: "disconnected" })
}
