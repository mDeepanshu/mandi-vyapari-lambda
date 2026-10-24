const serverless = require("serverless-http");
const express = require("express");
const app = express();
const { neon } = require("@neondatabase/serverless");
require("dotenv").config();
const webpush = require("web-push");
const cors = require("cors");

app.use(
  cors({
    // Vyapari app (production domain + Vercel URL) and mandi-application, which sends notifications
    origin: ["https://mva.make73.com", "https://mandi-vyapari.vercel.app", "https://mandi-application-seven.vercel.app"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true, // if you use cookies or auth headers
  })
);

app.options("*", cors());

app.use(express.json());

const secretkeys = {
  publicKey: process.env.PUBLIC_KEY,
  privateKey: process.env.PRIVATE_KEY,
};

async function dbClient() {
  const sql = neon(process.env.DATABASE_URL);
  return sql;
}

app.post("/subscribe", async (req, res) => {
  const sql = await dbClient();

  try {
    const { vyapariId, subscription: pushSub } = req.body;
    if (!vyapariId || vyapariId === "undefined" || !pushSub?.endpoint || !pushSub?.keys) {
      return res.status(400).json({ error: "vyapariId and subscription are required" });
    }

    // Keep one subscription per trader: always the latest phone/browser. Replacing the row
    // (instead of updating it) means a new phone or reinstall is saved, not silently ignored.
    await sql`
      DELETE FROM subscriptions WHERE vyapariId = ${vyapariId} OR endpoint = ${pushSub.endpoint};
    `;
    await sql`
      INSERT INTO subscriptions (vyapariId, endpoint, p256dh, auth)
      VALUES (${vyapariId}, ${pushSub.endpoint}, ${pushSub.keys.p256dh}, ${pushSub.keys.auth});
    `;

    return res.status(201).json({ message: "Subscription saved!" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save subscription" });
  }
});

app.post("/sendNotification/:vyapariId", async (req, res) => {
  webpush.setVapidDetails("mailto:example@yourdomain.org", secretkeys.publicKey, secretkeys.privateKey);
  const sql = await dbClient();

  try {
    const { vyapariId } = req.params;

    const rows = await sql`
      SELECT * FROM subscriptions WHERE vyapariId = ${vyapariId};
    `;

    if (rows.length === 0) {
      return res.status(404).json({ error: "No subscription found for this vyapari" });
    }

    const { amount, date, ledger } = req.body;
    const content = ledger
      ? { title: "LEDGER RECEIVED/लेजर प्राप्त हुआ", body: "आपका नया लेजर आ गया है। देखने के लिए टैप करें।" }
      : { title: "VASULI RECEIPT/वसूली रसीद", body: `Amount/राशि: ${amount}, Date/तारीख: ${date}` };

    const payload = JSON.stringify({
      notification: {
        ...content,
        icon: "icons/icon-192x192.png",
        // Angular's service worker only opens the app on tap when this is set
        data: { onActionClick: { default: { operation: "focusLastFocusedOrOpen", url: "/" } } },
      },
    });

    const results = await Promise.all(
      rows.map(async (row) => {
        const sub = {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        };

        try {
          await webpush.sendNotification(sub, payload);
          return true;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            // Subscription expired or the app was removed from that phone; drop it
            await sql`DELETE FROM subscriptions WHERE endpoint = ${row.endpoint};`;
          } else {
            console.error("Push error", err);
          }
          return false;
        }
      })
    );

    const sent = results.filter(Boolean).length;
    return res.status(200).json({ message: `Notification sent to vyapariId ${vyapariId}`, sent, failed: results.length - sent });
  } catch (err) {
    return res.status(500).json({ error: err.toString() });
  }
});

app.get("/", async (req, res, next) => {
  return res.status(200).json({
    message: "Hello from root 2!",
  });
});

app.get("/hello", async (req, res, next) => {
  return res.status(200).json({
    message: "Hello from rootw 2!",
  });
});

app.use((req, res, next) => {
  return res.status(404).json({
    error: "No route Found",
  });
});

exports.app = serverless(app);
