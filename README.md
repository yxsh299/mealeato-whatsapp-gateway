# Mealeato WhatsApp Gateway (24/7 Persistent Worker)

A standalone, dedicated 24/7 Node.js gateway process for WhatsApp Web connectivity using BerryProtocol multi-device WebSockets.

---

### Features
1. **24/7 Always Alive**: Operates on a continuous Node.js runtime to prevent WebSocket heartbeats from dropping.
2. **Built-in Self-Ping Watchdog**: Periodically pings `/health` and monitors connection status every 45s to prevent cloud free-tier sleeping.
3. **Automatic Supabase Session Sync**: Saves authentication keys directly to Supabase (`polaris_audit_log`). When the service redeploys or restarts, it automatically restores credentials and reconnects in seconds without needing a new QR scan.
4. **Seamless Integration**: Full REST API contract matching Polaris, Seller App, and Customer App endpoints.

---

### Deployment on Render (100% Free 24/7)

1. Log in to [Render.com](https://render.com) and click **New > Web Service**.
2. Connect your **Mealeato** GitHub repository.
3. Configure settings:
   - **Name**: `mealeato-whatsapp-gateway`
   - **Root Directory**: `whatsapp-gateway`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
4. Add Environment Variables:
   - `SUPABASE_URL`: `https://mlvyvoxhnwxxjpawdalb.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: `(Your Supabase Service Role Key)`
   - `SELF_URL`: `https://<your-render-service-name>.onrender.com`
   - `PORT`: `10000`
5. Click **Create Web Service**.
6. Once deployed, copy your URL (e.g. `https://mealeato-whatsapp-gateway.onrender.com`).
7. Open **Polaris Admin > WhatsApp Gateway > Gateway Settings & Templates**:
   - Paste the URL into **Dedicated 24/7 Gateway Server URL**.
   - Click **Save Gateway Configuration**.
8. Go to **Device Pairing & Session**, click **QR Code Scan** or **8-Digit Pairing Code**, and link your WhatsApp. It will stay connected 24/7.
