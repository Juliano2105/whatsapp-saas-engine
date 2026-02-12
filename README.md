# WhatsApp SaaS Engine

## Rodar local
1. npm install
2. copie .env.example para .env e preencha SUPABASE_URL e SUPABASE_KEY
3. npm run dev

## Endpoints
GET /status
GET /chats?limit=30&cursor=TIMESTAMP
GET /messages?chat_id=JID&limit=50&cursor=TIMESTAMP

## Railway
Conecte o repositório e mantenha o script start como node src/index.js
