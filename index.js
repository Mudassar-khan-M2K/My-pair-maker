require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = "/tmp/wa-sessions";

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Active sessions tracker ──────────────────────────────────────────────────
const activeSessions = new Map();

// ─── Clean up old session folder ─────────────────────────────────────────────
function cleanSession(id) {
  const dir = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Encode session folder → base64 SESSION_ID ───────────────────────────────
function encodeSession(sessionDir) {
  const files = fs.readdirSync(sessionDir);
  const data = {};
  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    try {
      data[file] = fs.readFileSync(filePath, "utf-8");
    } catch (_) {}
  }
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

// ─── API: Request pairing code ────────────────────────────────────────────────
app.post("/api/pair", async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number is required" });

  // Sanitize: digits only
  phone = phone.replace(/[^0-9]/g, "");
  if (phone.length < 10) return res.status(400).json({ error: "Invalid phone number" });

  // Kill existing session for this phone if any
  if (activeSessions.has(phone)) {
    try { activeSessions.get(phone).end(); } catch (_) {}
    activeSessions.delete(phone);
  }
  cleanSession(phone);

  const sessionDir = path.join(SESSIONS_DIR, phone);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      browser: ["Ubuntu", "Chrome", "120.0.0.0"],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 20000,
      generateHighQualityLinkPreview: false,
    });

    activeSessions.set(phone, sock);

    // Wait for WS to be OPEN before requesting pairing code
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 15000);
      const check = setInterval(() => {
        if (sock.ws && sock.ws.readyState === 1) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 200);
    });

    const code = await sock.requestPairingCode(phone);
    const formatted = code?.match(/.{1,4}/g)?.join("-") || code;

    // Listen for successful connection → encode session → send back
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        await saveCreds();
        const sessionId = encodeSession(sessionDir);

        // Send session ID via SSE (handled separately) — store it
        sock._sessionId = sessionId;
        sock._connected = true;
        console.log(`[✅] Phone ${phone} connected. SESSION_ID generated.`);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          // Don't reconnect in session generator
        }
        activeSessions.delete(phone);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    res.json({ success: true, code: formatted, phone });

  } catch (err) {
    console.error("[pair error]", err.message);
    cleanSession(phone);
    activeSessions.delete(phone);
    res.status(500).json({ error: err.message || "Failed to generate pairing code" });
  }
});

// ─── API: Poll for SESSION_ID (after pairing) ─────────────────────────────────
app.get("/api/session/:phone", (req, res) => {
  let phone = req.params.phone.replace(/[^0-9]/g, "");
  const sock = activeSessions.get(phone);

  if (!sock) return res.json({ status: "not_found" });
  if (sock._connected && sock._sessionId) {
    return res.json({ status: "connected", sessionId: sock._sessionId });
  }
  return res.json({ status: "waiting" });
});

// ─── Serve main page ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🇵🇰 Pakistan Jobs Bot — Session Generator`);
  console.log(`🌐 Running on port ${PORT}`);
  console.log(`🔗 Open: http://localhost:${PORT}\n`);
});
