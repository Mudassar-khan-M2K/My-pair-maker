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
  Browsers,
} = require("maher-zubair-baileys");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = "/tmp/wa-sessions";
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = {};

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

async function startPairing(phone) {
  cleanSession(phone);
  const sessionDir = path.join(SESSIONS_DIR, phone);
  fs.mkdirSync(sessionDir, { recursive: true });
  sessions[phone] = { status: "connecting", code: null, sessionId: null, error: null };

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const logger = pino({ level: "silent" });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu("Chrome"),
      defaultQueryTimeoutMs: undefined,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    let codeSent = false;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !codeSent) {
        codeSent = true;
        try {
          await new Promise(r => setTimeout(r, 1000));
          const code = await sock.requestPairingCode(phone);
          const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
          sessions[phone].code = formatted;
          sessions[phone].status = "code_ready";
          console.log(`[CODE] ${phone} → ${formatted}`);
        } catch (err) {
          console.error(`[CODE ERR] ${err.message}`);
          sessions[phone].status = "error";
          sessions[phone].error = err.message;
        }
      }

      if (connection === "open") {
        await saveCreds();
        sessions[phone].sessionId = encodeSession(sessionDir);
        sessions[phone].status = "connected";
        console.log(`[DONE] ${phone} paired!`);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[CLOSE] ${phone} code=${code}`);
        if (sessions[phone]?.status !== "connected") {
          sessions[phone].status = "error";
          sessions[phone].error = `Closed (${code}). Try again.`;
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

  } catch (err) {
    console.error(`[FATAL] ${phone}:`, err.message);
    if (sessions[phone]) { sessions[phone].status = "error"; sessions[phone].error = err.message; }
  }
}

app.post("/api/pair", (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone required" });
  phone = phone.replace(/[^0-9]/g, "");
  if (phone.length < 10) return res.status(400).json({ error: "Invalid number" });
  delete sessions[phone];
  startPairing(phone).catch(console.error);
  res.json({ success: true, phone });
});

app.get(["/api/status/:phone", "/api/session/:phone"], (req, res) => {
  const phone = req.params.phone.replace(/[^0-9]/g, "");
  const s = sessions[phone];
  if (!s) return res.json({ status: "not_found" });
  res.json({ status: s.status, code: s.code, sessionId: s.sessionId, error: s.error });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Session Generator on port ${PORT}`));
