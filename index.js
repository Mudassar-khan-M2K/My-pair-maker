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
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = "/tmp/wa-sessions";

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();

function cleanSession(id) {
  const dir = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function encodeSession(sessionDir) {
  const files = fs.readdirSync(sessionDir);
  const data = {};
  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    try { data[file] = fs.readFileSync(filePath, "utf-8"); } catch (_) {}
  }
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

// ─── API: Request pairing code ────────────────────────────────────────────────
app.post("/api/pair", async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number is required" });

  phone = phone.replace(/[^0-9]/g, "");
  if (phone.length < 10) return res.status(400).json({ error: "Invalid phone number" });

  // Kill existing session
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
      auth: state,
      browser: ["Ubuntu", "Chrome", "120.0.0.0"],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 20000,
      defaultQueryTimeoutMs: 60000,
      emitOwnEvents: false,
      fireInitQueries: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    activeSessions.set(phone, sock);

    // Wait up to 60s for WS to open
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket open timeout — please try again")), 60000);
      const check = setInterval(() => {
        if (sock.ws && sock.ws.readyState === 1) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 500);
    });

    const code = await sock.requestPairingCode(phone);
    const formatted = code?.match(/.{1,4}/g)?.join("-") || code;

    sock.ev.on("connection.update", async (update) => {
      const { connection } = update;
      if (connection === "open") {
        await saveCreds();
        sock._sessionId = encodeSession(sessionDir);
        sock._connected = true;
        console.log(`[OK] ${phone} connected. SESSION_ID ready.`);
      }
      if (connection === "close") {
        activeSessions.delete(phone);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    res.json({ success: true, code: formatted, phone });

  } catch (err) {
    console.error("[pair error]", err.message);
    cleanSession(phone);
    activeSessions.delete(phone);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Poll for SESSION_ID ─────────────────────────────────────────────────
app.get("/api/session/:phone", (req, res) => {
  const phone = req.params.phone.replace(/[^0-9]/g, "");
  const sock = activeSessions.get(phone);
  if (!sock) return res.json({ status: "not_found" });
  if (sock._connected && sock._sessionId) return res.json({ status: "connected", sessionId: sock._sessionId });
  return res.json({ status: "waiting" });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Pakistan Jobs Bot - Session Generator running on port " + PORT);
});
