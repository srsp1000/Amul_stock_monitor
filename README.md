# 🥛 Amul Stock Monitor

Monitors the Amul shop page and **instantly notifies you via Email and/or Telegram** the moment the product comes back in stock.

Currently watching: **Amul High Protein Rose Lassi, 200mL — Pack of 30**

---

## 🚀 Deploy to Render (Free Tier)

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/amul-stock-monitor.git
git push -u origin main
```

### Step 2 — Create a Render Web Service

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Fill in:
   | Field | Value |
   |-------|-------|
   | **Name** | `amul-stock-monitor` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | `Free` |

### Step 3 — Set Environment Variables

In Render dashboard → **Environment** tab, add:

| Variable | Value |
|----------|-------|
| `SMTP_USER` | `your-gmail@gmail.com` |
| `SMTP_PASS` | Your [Gmail App Password](https://myaccount.google.com/apppasswords) |
| `NOTIFY_EMAIL` | Email address to receive alerts |
| `TELEGRAM_BOT_TOKEN` | *(optional)* From @BotFather |
| `TELEGRAM_CHAT_ID` | *(optional)* From @userinfobot |
| `CHECK_INTERVAL_MS` | `300000` (5 min) or `60000` (1 min) |

> **Gmail App Password**: Go to Google Account → Security → 2-Step Verification → App Passwords → Generate one for "Mail"

### Step 4 — Deploy!

Click **Deploy**. The service starts monitoring immediately.

---

## 📬 Notifications

### Email
You'll get a nicely formatted HTML email with a direct **"Buy Now"** link the moment stock changes from out-of-stock to in-stock.

### Telegram (Recommended — instant!)
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Message [@userinfobot](https://t.me/userinfobot) → copy your Chat ID
3. Set both as env vars on Render

---

## 🩺 Health Check

Your Render URL serves a live status page:

```
GET https://your-app.onrender.com/
```

Returns JSON:
```json
{
  "service": "Amul Stock Monitor",
  "stockStatus": "Out of Stock ❌",
  "checksPerformed": 42,
  "lastChecked": "2024-01-15T10:30:00.000Z",
  "checkInterval": "300s",
  "uptime": "3h 15m 20s"
}
```

---

## 🔧 Run Locally

```bash
npm install
cp .env.example .env   # fill in your values
node monitor.js
```

---

## ⚙️ Configuration

All config via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PRODUCT_URL` | Amul Rose Lassi URL | Page to monitor |
| `PRODUCT_NAME` | Amul High Protein Rose Lassi | Display name in alerts |
| `CHECK_INTERVAL_MS` | `300000` | Poll frequency in ms |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | Your email login |
| `SMTP_PASS` | — | Email password / App Password |
| `NOTIFY_EMAIL` | — | Where to send alerts |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | — | Your Telegram chat/user ID |
| `PORT` | `10000` | Health server port |

---

## ⚠️ Notes

- **Render Free Tier** spins down after 15 min of inactivity. The built-in HTTP server keeps it alive as long as Render pings it (Render does this for web services).
- Set `CHECK_INTERVAL_MS=60000` (1 minute) if you want faster detection, but be mindful of being rate-limited by Amul's servers.
- The script detects stock by scanning the HTML for `"Out of Stock"` / `"Add to Cart"` / schema.org availability markers.
