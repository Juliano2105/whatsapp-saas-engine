export function normalizeBrazilToJid(number, jid) {
  const cleanNumber = String(number || "").replace(/\D/g, "")
  const finalNumber =
    cleanNumber.length === 13 && cleanNumber.startsWith("55")
      ? cleanNumber.slice(0, 4) + cleanNumber.slice(5)
      : cleanNumber

  return jid || (finalNumber + "@s.whatsapp.net")
}
