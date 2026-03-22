# 🇵🇰 Pakistan Jobs Bot — Session Generator

A beautiful web app to generate your WhatsApp SESSION_ID.
Deploy once on Render.com (free), pair your WhatsApp, copy SESSION_ID — done!

---

## 🚀 Deploy on Render.com (Free)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "session generator"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/session-generator.git
git push -u origin main
```

### Step 2 — Deploy on Render
1. Go to https://render.com → Sign up free
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Settings:
   - **Name:** pakistan-jobs-session
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** Free
5. Click **"Create Web Service"**
6. Wait ~2 minutes for deploy

### Step 3 — Use It
1. Open your Render URL (e.g. `https://pakistan-jobs-session.onrender.com`)
2. Enter your WhatsApp number: `923216046022`
3. Click **"Get Pairing Code"**
4. Open WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number
5. Enter the 8-digit code shown on screen
6. Wait 5-10 seconds → **SESSION_ID appears!**
7. Copy it carefully — you'll need it for the Heroku bot

---

## ⚠️ Important Notes
- The SESSION_ID is like a password — keep it private
- You only need to do this ONCE
- After getting SESSION_ID, you can stop/delete this Render app
- Render free tier may sleep after 15 min inactivity — just refresh to wake it
