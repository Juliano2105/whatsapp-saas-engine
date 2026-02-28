async buildProxyAgent() {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.ENGINE_AUTOMATION_KEY;
    if (!url || !key) return undefined;

    const res = await fetch(
      `${url}/functions/v1/get-proxy-config?engine_id=${this.sessionId}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) {
      console.error(`[${this.sessionId}] get-proxy-config HTTP ${res.status}`);
      return undefined;
    }
    const data = await res.json();
    if (!data.enabled) return undefined;

    const user = data.username || "";
    const pass = data.password || "";
    const auth = user ? `${user}:${pass}@` : "";

    const proxyUrl = data.protocol === "socks5"
      ? `socks5://${auth}${data.host}:${data.port}`
      : `http://${auth}${data.host}:${data.port}`;

    const agent = data.protocol === "socks5"
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);

    console.log(`[${this.sessionId}] Proxy ${data.protocol} configurado: ${data.host}:${data.port}`);
    return agent;
  } catch (err) {
    console.error(`[${this.sessionId}] Erro ao carregar proxy:`, err.message);
    return undefined;
  }
}
