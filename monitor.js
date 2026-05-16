const https = require("https");
const http = require("http");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

// ─── GLOBAL CONFIG ─────────────────────────────────────────────────────────────
const CONFIG = {
  CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS || "300000"),
  STAGGER_MS: parseInt(process.env.STAGGER_MS || "8000"),
  SMTP_HOST: process.env.SMTP_HOST || "smtp.gmail.com",
  SMTP_PORT: parseInt(process.env.SMTP_PORT || "587"),
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  PORT: parseInt(process.env.PORT || "10000"),
};

// ─── PRODUCTS LIST ─────────────────────────────────────────────────────────────
// Three ways to define products (in priority order):
//
// 1. PRODUCTS_JSON env var (best for Render) — a JSON array, e.g.:
//    [{"name":"Rose Lassi","url":"https://...","emoji":"🌹"},{"name":"Mango Lassi","url":"https://...","emoji":"🥭"}]
//
// 2. products.json file in the same directory as monitor.js
//    Same format as above.
//
// 3. Edit the defaultProducts array below directly (then redeploy).

const defaultProducts = [
  {
    name: "Amul High Protein Rose Lassi (Pack of 30)",
    url: "https://shop.amul.com/en/product/amul-high-protein-rose-lassi-200-ml-or-pack-of-30",
    emoji: "🌹",
  },
  // ── Add more products below ──────────────────────────────────────────────
  // {
  //   name: "Amul High Protein Mango Lassi (Pack of 30)",
  //   url: "https://shop.amul.com/en/product/amul-high-protein-mango-lassi-200-ml-or-pack-of-30",
  //   emoji: "🥭",
  // },
  // {
  //   name: "Amul Kool Kulfi Flavoured Milk",
  //   url: "https://shop.amul.com/en/product/...",
  //   emoji: "🍦",
  // },
];

function loadProducts() {
  if (process.env.PRODUCTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.PRODUCTS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`📦 Loaded ${parsed.length} product(s) from PRODUCTS_JSON env var`);
        return parsed;
      }
    } catch (e) {
      console.error("⚠️  PRODUCTS_JSON parse error:", e.message);
    }
  }

  const jsonFile = path.join(__dirname, "products.json");
  if (fs.existsSync(jsonFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`📦 Loaded ${parsed.length} product(s) from products.json`);
        return parsed;
      }
    } catch (e) {
      console.error("⚠️  products.json parse error:", e.message);
    }
  }

  console.log(`📦 Using ${defaultProducts.length} default product(s)`);
  return defaultProducts;
}

// ─── PER-PRODUCT STATE ─────────────────────────────────────────────────────────
const productState = new Map(); // url → state

function initState(product) {
  productState.set(product.url, {
    name: product.name,
    url: product.url,
    emoji: product.emoji || "🛒",
    stockStatus: null,   // null = unknown, true = inStock, false = outOfStock
    lastChecked: null,
    lastError: null,
    checkCount: 0,
    notifiedAt: null,
  });
}

// ─── FETCH ─────────────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Cache-Control": "no-cache",
        },
        timeout: 25000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out after 25s"));
    });
  });
}

// ─── STOCK DETECTION ───────────────────────────────────────────────────────────
function detectStockStatus(html) {
  const body = html.toLowerCase();

  const OUT_SIGNALS = [
    "out of stock",
    "outofstock",
    "out_of_stock",
    '"availability":"http://schema.org/outofstock"',
    "notify me when available",
    "currently unavailable",
  ];

  const IN_SIGNALS = [
    '"availability":"http://schema.org/instock"',
    "add to cart",
    "addtocart",
    "add-to-cart",
    '"instock"',
    "buy now",
  ];

  const isOut = OUT_SIGNALS.some((s) => body.includes(s));
  const isIn  = IN_SIGNALS.some((s) => body.includes(s));

  if (isIn && !isOut) return true;
  if (isOut) return false;
  return null;
}

// ─── CHECK ONE PRODUCT ─────────────────────────────────────────────────────────
async function checkProduct(product) {
  const state = productState.get(product.url);
  state.checkCount++;
  state.lastChecked = new Date();

  console.log(`\n  ${state.emoji} ${state.name}`);

  try {
    const { statusCode, body } = await fetchUrl(state.url);
    if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

    const current = detectStockStatus(body);

    const label =
      current === true  ? "✅ IN STOCK"    :
      current === false ? "❌ Out of Stock" : "⚠️  Ambiguous";
    console.log(`     Status : ${label}`);

    // Transition out-of-stock → in-stock: NOTIFY
    if (current === true && state.stockStatus !== true) {
      console.log(`     🚨 STOCK CHANGE DETECTED — notifying!`);
      state.notifiedAt = new Date();
      await sendNotifications(state);
    }

    if (current !== null) state.stockStatus = current;
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
    console.error(`     ❌ Error: ${err.message}`);
  }
}

// ─── CHECK ALL (staggered) ─────────────────────────────────────────────────────
let roundCount = 0;

async function checkAllProducts(products) {
  roundCount++;
  console.log(`\n${"━".repeat(60)}`);
  console.log(`🔍 Round #${roundCount} — ${new Date().toISOString()}`);
  console.log(`   Checking ${products.length} product(s) (${CONFIG.STAGGER_MS / 1000}s apart)`);
  console.log("━".repeat(60));

  for (let i = 0; i < products.length; i++) {
    if (i > 0) await sleep(CONFIG.STAGGER_MS);
    await checkProduct(products[i]);
  }

  console.log(`\n✔  Round #${roundCount} complete.\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────────
async function sendNotifications(state) {
  const jobs = [];

  if (CONFIG.SMTP_USER && CONFIG.SMTP_PASS && CONFIG.NOTIFY_EMAIL) {
    jobs.push(sendEmail(state).catch((e) => console.error(`     ❌ Email: ${e.message}`)));
  } else {
    console.log("     📧 Email skipped (not configured)");
  }

  if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    jobs.push(sendTelegram(state).catch((e) => console.error(`     ❌ Telegram: ${e.message}`)));
  } else {
    console.log("     📱 Telegram skipped (not configured)");
  }

  await Promise.allSettled(jobs);
}

async function sendEmail(state) {
  const transporter = nodemailer.createTransport({
    host: CONFIG.SMTP_HOST,
    port: CONFIG.SMTP_PORT,
    secure: CONFIG.SMTP_PORT === 465,
    auth: { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASS },
  });

  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  await transporter.sendMail({
    from: `"Stock Monitor 🛒" <${CONFIG.SMTP_USER}>`,
    to: CONFIG.NOTIFY_EMAIL,
    subject: `✅ IN STOCK: ${state.emoji} ${state.name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;
                  border:2px solid #a0ce4e;border-radius:12px;overflow:hidden;">
        <div style="background:#a0ce4e;padding:20px;text-align:center;">
          <div style="font-size:48px;margin-bottom:8px;">${state.emoji}</div>
          <h1 style="color:white;margin:0;font-size:24px;">🎉 Back In Stock!</h1>
        </div>
        <div style="padding:24px;">
          <h2 style="color:#333;margin-top:0;">${state.name}</h2>
          <p style="color:#666;font-size:16px;">
            The product you've been watching is
            <strong style="color:#3a7d3a;">NOW IN STOCK</strong>!
          </p>
          <p style="color:#999;font-size:14px;">Detected at: ${now} IST</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${state.url}"
               style="background:#a0ce4e;color:white;padding:14px 32px;text-decoration:none;
                      border-radius:8px;font-size:18px;font-weight:bold;display:inline-block;">
              🛒 Buy Now →
            </a>
          </div>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-bottom:0;">
            Hurry — stock may sell out fast! Sent by your Stock Monitor.
          </p>
        </div>
      </div>`,
  });

  console.log(`     📧 Email sent → ${CONFIG.NOTIFY_EMAIL}`);
}

async function sendTelegram(state) {
  const text = encodeURIComponent(
    `🎉 *IN STOCK NOW!*\n\n` +
    `${state.emoji} *${state.name}*\n\n` +
    `Grab it before it sells out:\n${state.url}`
  );
  const url =
    `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}` +
    `/sendMessage?chat_id=${CONFIG.TELEGRAM_CHAT_ID}&text=${text}&parse_mode=Markdown`;

  const { statusCode, body } = await fetchUrl(url);
  if (statusCode !== 200) {
    const detail = (() => { try { return JSON.parse(body).description; } catch { return ""; } })();
    throw new Error(`HTTP ${statusCode} ${detail}`);
  }
  console.log(`     📱 Telegram sent`);
}

// ─── DASHBOARD SERVER ──────────────────────────────────────────────────────────
function startDashboard(products) {
  const server = http.createServer((req, res) => {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);

    // JSON endpoint
    if (req.url === "/json") {
      const data = {
        uptime: `${h}h ${m}m ${s}s`,
        roundsCompleted: roundCount,
        checkIntervalSeconds: CONFIG.CHECK_INTERVAL_MS / 1000,
        products: products.map((p) => {
          const st = productState.get(p.url);
          return {
            name: st.name, url: st.url, emoji: st.emoji,
            stockStatus:
              st.stockStatus === true  ? "IN STOCK"     :
              st.stockStatus === false ? "Out of Stock" : "Unknown",
            checkCount: st.checkCount,
            lastChecked: st.lastChecked,
            lastError: st.lastError,
            lastNotified: st.notifiedAt,
          };
        }),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    // HTML dashboard
    const rows = products.map((p) => {
      const st = productState.get(p.url);
      const cls =
        st.stockStatus === true  ? "in-stock"    :
        st.stockStatus === false ? "out-of-stock" : "unknown";
      const badge =
        st.stockStatus === true  ? "✅ IN STOCK"    :
        st.stockStatus === false ? "❌ Out of Stock" : "⚠️ Unknown";
      const lastCheck = st.lastChecked
        ? st.lastChecked.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "Pending…";

      return `
        <tr class="${cls}">
          <td class="emoji-cell">${st.emoji}</td>
          <td>
            <a href="${st.url}" target="_blank" rel="noopener">${st.name}</a>
          </td>
          <td><span class="badge">${badge}</span></td>
          <td class="meta">
            Checks: <b>${st.checkCount}</b><br>
            <span class="dim">${lastCheck} IST</span>
            ${st.lastError ? `<br><span class="err">⚠ ${st.lastError}</span>` : ""}
            ${st.notifiedAt ? `<br><span class="notified">📬 Notified ${st.notifiedAt.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST</span>` : ""}
          </td>
        </tr>`;
    }).join("");

    const inStockCount  = [...productState.values()].filter((s) => s.stockStatus === true).length;
    const outCount      = [...productState.values()].filter((s) => s.stockStatus === false).length;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>🥛 Stock Monitor</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #f0f4f0; color: #1e2e1e; min-height: 100vh; padding: 24px 16px;
  }
  header { text-align: center; margin-bottom: 28px; }
  header h1 { font-size: 1.9rem; color: #2d6a2d; }
  header p { color: #777; margin-top: 6px; font-size: 0.85rem; }
  header a { color: #2d6a2d; }
  .stats {
    display: flex; gap: 12px; flex-wrap: wrap;
    justify-content: center; margin-bottom: 28px;
  }
  .stat {
    background: white; border-radius: 10px; padding: 14px 22px;
    text-align: center; box-shadow: 0 1px 5px rgba(0,0,0,.08); min-width: 120px;
  }
  .stat .val { font-size: 1.7rem; font-weight: 700; color: #2d6a2d; }
  .stat .lbl { font-size: 0.72rem; color: #999; margin-top: 3px; text-transform: uppercase; letter-spacing:.05em; }
  .wrap { max-width: 950px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; background: white;
          border-radius: 12px; overflow: hidden; box-shadow: 0 2px 14px rgba(0,0,0,.08); }
  th { background: #2d6a2d; color: white; padding: 12px 16px; text-align: left;
       font-size: 0.78rem; text-transform: uppercase; letter-spacing: .06em; }
  td { padding: 14px 16px; border-bottom: 1px solid #edf2ed; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr.in-stock   td { background: #f2fff2; }
  tr.out-of-stock td { background: #fff4f4; }
  tr.unknown    td { background: #fffde8; }
  .emoji-cell { font-size: 1.5rem; text-align: center; width: 48px; }
  td a { color: #2d5f2d; font-weight: 600; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .badge {
    display: inline-block; padding: 4px 13px; border-radius: 20px;
    font-size: 0.82rem; font-weight: 600; white-space: nowrap;
  }
  .in-stock    .badge { background: #d4edda; color: #155724; }
  .out-of-stock .badge { background: #f8d7da; color: #721c24; }
  .unknown     .badge { background: #fff3cd; color: #856404; }
  .meta { font-size: 0.8rem; line-height: 1.6; }
  .dim { color: #999; }
  .err { color: #c0392b; }
  .notified { color: #2d6a2d; }
  footer { text-align: center; color: #bbb; font-size: 0.76rem; margin-top: 20px; }
  @media(max-width:600px) { .meta { display: none; } th:last-child { display: none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🥛 Stock Monitor Dashboard</h1>
    <p>Auto-refreshes every 60 s &nbsp;·&nbsp; <a href="/json">JSON API</a></p>
  </header>

  <div class="stats">
    <div class="stat"><div class="val">${products.length}</div><div class="lbl">Watching</div></div>
    <div class="stat"><div class="val" style="color:#155724">${inStockCount}</div><div class="lbl">In Stock</div></div>
    <div class="stat"><div class="val" style="color:#721c24">${outCount}</div><div class="lbl">Out of Stock</div></div>
    <div class="stat"><div class="val">${roundCount}</div><div class="lbl">Rounds Done</div></div>
    <div class="stat"><div class="val">${h}h ${m}m</div><div class="lbl">Uptime</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th></th><th>Product</th><th>Status</th><th>Details</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <footer>
    <p>Notifying: ${CONFIG.NOTIFY_EMAIL || "email not set"} &nbsp;·&nbsp;
       Telegram: ${CONFIG.TELEGRAM_BOT_TOKEN ? "✅" : "not set"} &nbsp;·&nbsp;
       Interval: ${CONFIG.CHECK_INTERVAL_MS / 1000}s</p>
    <p style="margin-top:4px">
      Generated ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST
    </p>
  </footer>
</div>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`🌐 Dashboard → http://localhost:${CONFIG.PORT}`);
    console.log(`📊 JSON API  → http://localhost:${CONFIG.PORT}/json\n`);
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const products = loadProducts();

  console.log("━".repeat(60));
  console.log("  🥛 Stock Monitor — Multi-Product Edition");
  console.log("━".repeat(60));
  products.forEach((p) => console.log(`  ${p.emoji || "🛒"} ${p.name}`));
  console.log(`\n  Interval : every ${CONFIG.CHECK_INTERVAL_MS / 1000}s`);
  console.log(`  Stagger  : ${CONFIG.STAGGER_MS / 1000}s between products`);
  console.log(`  Email    : ${CONFIG.NOTIFY_EMAIL || "⚠️  Not configured"}`);
  console.log(`  Telegram : ${CONFIG.TELEGRAM_BOT_TOKEN ? "✅ Configured" : "Not configured"}`);
  console.log("━".repeat(60) + "\n");

  if (!CONFIG.SMTP_USER && !CONFIG.TELEGRAM_BOT_TOKEN) {
    console.warn(
      "⚠️  No notification method set.\n" +
      "   Add SMTP_USER + SMTP_PASS + NOTIFY_EMAIL for email.\n" +
      "   Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for Telegram.\n"
    );
  }

  products.forEach(initState);
  startDashboard(products);

  await checkAllProducts(products);
  setInterval(() => checkAllProducts(products), CONFIG.CHECK_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
