const serverless = require("serverless-http");
const express = require("express");
const app = express();
const { neon } = require("@neondatabase/serverless");
require("dotenv").config();
const webpush = require("web-push");
const cors = require("cors");

app.use(
  cors({
    origin: "https://mandi-vyapari.vercel.app", // replace with your deployed FE URL
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
    const sub = req.body;
    const pushSub = sub.subscription;
    
    const existing = await sql`
      SELECT * FROM subscriptions WHERE vyapariId = ${sub.vyapariId};
    `;

    if (existing.length === 0) {
      await sql`
        INSERT INTO subscriptions (vyapariId, endpoint, p256dh, auth)
        VALUES (${sub.vyapariId}, ${pushSub.endpoint}, ${pushSub.keys.p256dh}, ${pushSub.keys.auth});
      `;
    } else {
      await sql`
        UPDATE subscriptions
        SET p256dh = ${pushSub.keys.p256dh}, auth = ${pushSub.keys.auth}
        WHERE vyapariId = ${pushSub.vyapariId} AND endpoint = ${pushSub.endpoint};
      `;
    }

    res.status(201).json({ message: "Subscription saved!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save subscription" });
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

    const payload = JSON.stringify({
      notification: {
        title: "VASULI RECEIPT/वसूली रसीद",
        body: `Amount/राशि: ${req.body.amount}, Date/तारीख: ${req.body.date}`,
      },
    });

    await Promise.all(
      rows.map((row) => {
        const sub = {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        };

        return webpush.sendNotification(sub, payload).catch((err) => {
          console.error("Push error", err);
        });
      })
    );

    res.status(200).json({ message: `Notification sent to vyapariId ${vyapariId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
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
