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

// state[phone] = { status, code, sessionId, error }
const state = {};

function cleanSession(phone) {
  const dir = path.join(SESSIONS_DIR, phone);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function encodeSession(sessionDir) {
  const data = {};
  for (const file of fs.readdirSync(sessionDir)) {
    try { data[file] = fs.readFileSync(path.join(sessionDir, file), "utf-8"); } catch (_) {}
  }
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

// ─── Start pairing in background (never awaited by HTTP) ─────────────────────
async function startPairing(phone) {
  cleanSession(phone);
  const sessionDir = path.join(SESSIONS_DIR, phone);
  fs.mkdirSync(sessionDir, { recursive: true });
  state[phone] = { status: "connecting", code: null, sessionId: null, error: null };

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: authState,
      browser: ["Ubuntu", "Chrome", "120.0.0.0"],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
    });

    let pairingCodeRequested = false;

    // ── THE CORRECT PATTERN from official Baileys docs ──────────────────────
    // Request pairing code on "connecting" event — not by polling WS state
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Request pairing code when connecting OR when QR would show
      if ((connection === "connecting" || !!qr) && !pairingCodeRequested) {
        pairingCodeRequested = true;
        try {
          // Small delay to ensure socket is ready
          await new Promise(r => setTimeout(r, 1500));
          const code = await sock.requestPairingCode(phone);
          const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
          state[phone].code = formatted;
          state[phone].status = "code_ready";
          console.log(`[CODE] ${phone} → ${formatted}`);
        } catch (err) {
          console.error(`[CODE ERR] ${phone}:`, err.message);
          // Retry once after 2 seconds
          setTimeout(async () => {
            try {
              const code = await sock.requestPairingCode(phone);
              const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
              state[phone].code = formatted;
              state[phone].status = "code_ready";
              console.log(`[CODE RETRY OK] ${phone} → ${formatted}`);
            } catch (e) {
              state[phone].status = "error";
              state[phone].error = "Failed to get pairing code. Please try again.";
            }
          }, 2000);
        }
      }

      if (connection === "open") {
        await saveCreds();
        state[phone].sessionId = encodeSession(sessionDir);
        state[phone].status = "connected";
        console.log(`[DONE] ${phone} connected. SESSION_ID ready.`);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[CLOSE] ${phone} - code: ${code}`);
        if (state[phone]?.status !== "connected") {
          state[phone].status = "error";
          state[phone].error = "Connection closed. Please try again.";
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

  } catch (err) {
    console.error(`[START ERR] ${phone}:`, err.message);
    state[phone].status = "error";
    state[phone].error = err.message;
  }
}

// ─── POST /api/pair — returns immediately, pairing runs in background ─────────
app.post("/api/pair", (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number required" });
  phone = phone.replace(/[^0-9]/g, "");
  if (phone.length < 10) return res.status(400).json({ error: "Invalid phone number" });

  // Reset state
  if (state[phone]?.sock) { try { state[phone].sock.end(); } catch (_) {} }
  delete state[phone];

  // Fire and forget — no await
  startPairing(phone).catch(err => {
    console.error(err);
    if (state[phone]) { state[phone].status = "error"; state[phone].error = err.message; }
  });

  res.json({ success: true, phone });
});

// ─── GET /api/status/:phone — frontend polls this every 2s ───────────────────
app.get("/api/status/:phone", (req, res) => {
  const phone = req.params.phone.replace(/[^0-9]/g, "");
  const s = state[phone];
  if (!s) return res.json({ status: "not_found" });
  res.json({ status: s.status, code: s.code, sessionId: s.sessionId, error: s.error });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Session Generator running on port ${PORT}`));
