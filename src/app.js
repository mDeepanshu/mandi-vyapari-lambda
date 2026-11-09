const serverless = require("serverless-http");
const express = require("express");
const app = express();
const { neon } = require("@neondatabase/serverless");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const webpush = require("web-push");
const cors = require("cors");

// The hmb stage serves HMB; every other stage serves HIS. Decided by the stage
// name (set in serverless.yml), never by which env vars happen to be present,
// so HMB can't fall back to HIS's database or HIS's allowed sites.
const IS_HMB = process.env.STAGE === "hmb";

// Per-stage allowlist (comma-separated ALLOWED_ORIGINS); defaults are the HIS apps
const DEFAULT_ORIGINS = ["https://mva.make73.com", "https://mandi-vyapari.vercel.app", "https://mandi-application-seven.vercel.app"];
const envOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter((o) => o.startsWith("https://"));
if (IS_HMB && !envOrigins.length) throw new Error("hmb stage needs ALLOWED_ORIGINS (.env.hmb); refusing HIS defaults");

app.use(
  cors({
    origin: envOrigins.length ? envOrigins : DEFAULT_ORIGINS,
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

// Each client keeps subscriptions in its own database: HIS in Neon (DATABASE_URL, table
// "subscriptions"), HMB in its Supabase project (SUBSCRIPTIONS_SUPABASE_URL/KEY, table "push_subscriptions").
// Both stores keep one subscription per trader: always the latest phone/browser.
function neonStore() {
  const sql = neon(process.env.DATABASE_URL);
  return {
    async replace(vyapariId, pushSub) {
      // Replacing the row (instead of updating it) means a new phone or reinstall is saved
      await sql`
        DELETE FROM subscriptions WHERE vyapariId = ${vyapariId} OR endpoint = ${pushSub.endpoint};
      `;
      await sql`
        INSERT INTO subscriptions (vyapariId, endpoint, p256dh, auth)
        VALUES (${vyapariId}, ${pushSub.endpoint}, ${pushSub.keys.p256dh}, ${pushSub.keys.auth});
      `;
    },
    find: (vyapariId) => sql`SELECT * FROM subscriptions WHERE vyapariId = ${vyapariId};`,
    remove: (endpoint) => sql`DELETE FROM subscriptions WHERE endpoint = ${endpoint};`,
  };
}

function supabaseStore() {
  const table = () =>
    createClient(process.env.SUBSCRIPTIONS_SUPABASE_URL, process.env.SUBSCRIPTIONS_SUPABASE_KEY, { auth: { persistSession: false } }).from("push_subscriptions");
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    async replace(vyapariId, pushSub) {
      check(await table().delete().eq("vyapariid", vyapariId));
      check(
        await table().upsert({
          endpoint: pushSub.endpoint,
          vyapariid: vyapariId,
          p256dh: pushSub.keys.p256dh,
          auth: pushSub.keys.auth,
        })
      );
    },
    find: async (vyapariId) => check(await table().select("endpoint, p256dh, auth").eq("vyapariid", vyapariId)),
    remove: async (endpoint) => check(await table().delete().eq("endpoint", endpoint)),
  };
}

const store = () => {
  if (IS_HMB) {
    if (!(process.env.SUBSCRIPTIONS_SUPABASE_URL || "").startsWith("https://")) {
      throw new Error("hmb stage needs SUBSCRIPTIONS_SUPABASE_URL/KEY; refusing to use HIS's Neon database");
    }
    return supabaseStore();
  }
  return neonStore();
};

app.post("/subscribe", async (req, res) => {
  try {
    const { vyapariId, subscription: pushSub } = req.body;
    if (!vyapariId || vyapariId === "undefined" || !pushSub?.endpoint || !pushSub?.keys) {
      return res.status(400).json({ error: "vyapariId and subscription are required" });
    }

    await store().replace(vyapariId, pushSub);

    return res.status(201).json({ message: "Subscription saved!" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save subscription" });
  }
});

app.post("/sendNotification/:vyapariId", async (req, res) => {
  webpush.setVapidDetails("mailto:example@yourdomain.org", secretkeys.publicKey, secretkeys.privateKey);
  const db = store();

  try {
    const { vyapariId } = req.params;

    const rows = await db.find(vyapariId);

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
            await db.remove(row.endpoint);
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
