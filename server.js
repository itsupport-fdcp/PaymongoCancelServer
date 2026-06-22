require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = 3000;
const API_KEY = process.env.PAYMONGO_API_KEY;
const BASE_URL = process.env.PAYMONGO_BASE_URL || "https://api.paymongo.com/v1";
const AUTH = "Basic " + Buffer.from(API_KEY + ":").toString("base64");

app.use(express.static(path.join(__dirname)));

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
});

function paymongGet(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const options = {
      agent,
      headers: {
        Authorization: AUTH,
        "Content-Type": "application/json",
      },
    };
    const req = https
      .get(url, options, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500) {
            if (retries > 0) {
              console.log(`Retrying ${url} due to ${res.statusCode}. Retries left: ${retries - 1}`);
              return setTimeout(() => {
                paymongGet(url, retries - 1).then(resolve).catch(reject);
              }, 1000);
            }
          }
          if (res.statusCode >= 400) {
            return reject(
              new Error(`PayMongo error ${res.statusCode}: ${raw}`),
            );
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Invalid JSON from PayMongo: ${raw}`));
          }
        });
      })
      .on("error", (err) => {
        if (retries > 0) {
          console.log(`Retrying ${url} due to error: ${err.message}. Retries left: ${retries - 1}`);
          return setTimeout(() => {
            paymongGet(url, retries - 1).then(resolve).catch(reject);
          }, 1000);
        }
        reject(err);
      });
      
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request Timeout"));
    });
  });
}

app.get("/api/subscriptions", async (req, res) => {
  try {
    const { limit = 50, after, before, status } = req.query;
    let url = `${BASE_URL}/subscriptions?limit=${limit}`;
    if (after) url += `&after=${after}`;
    if (before) url += `&before=${before}`;
    if (status) url += `&status=${status}`;
    const result = await paymongGet(url);
    res.json({ data: result.data, has_more: result.has_more });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/subscriptions/:id/cancel", async (req, res) => {
  try {
    const url = `${BASE_URL}/subscriptions/${req.params.id}/cancel`;
    const body = JSON.stringify({
      data: {
        attributes: {
          cancel_at_period_end: false,
          cancellation_reason: "other",
        },
      },
    });
    const parsed = new URL(url);
    const result = await new Promise((resolve, reject) => {
      const options = {
        agent,
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: "POST",
        headers: {
          Authorization: AUTH,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };
      const request = https.request(options, (response) => {
        let raw = "";
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () => {
          if (response.statusCode >= 400) {
            return reject(
              new Error(`PayMongo error ${response.statusCode}: ${raw}`),
            );
          }
          resolve(JSON.parse(raw));
        });
      });
      request.on("error", reject);
      request.write(body);
      request.end();
    });
    res.json(result.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/customer/:id", async (req, res) => {
  try {
    const result = await paymongGet(`${BASE_URL}/customers/${req.params.id}`);
    res.json(result.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payment-method/:id", async (req, res) => {
  const id = req.params.id;
  const url = id.startsWith("cus_pm_")
    ? `${BASE_URL}/customer_payment_methods/${id}`
    : `${BASE_URL}/payment_methods/${id}`;
  try {
    const result = await paymongGet(url);
    console.log(
      "PM response:",
      JSON.stringify(result.data?.attributes, null, 2),
    );
    res.json(result.data);
  } catch (err) {
    console.error("PM fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve card brand/last4 via the PaymentIntent endpoint.
// Called by the frontend as: GET /api/payments?payment_intent_id=pi_xxx
// Fetches /v1/payment_intents/:id — attributes.payments[] has source info.
app.get("/api/payments", async (req, res) => {
  try {
    const { payment_intent_id } = req.query;
    if (!payment_intent_id) {
      return res.status(400).json({ error: "payment_intent_id is required" });
    }

    const result = await paymongGet(
      `${BASE_URL}/payment_intents/${encodeURIComponent(payment_intent_id)}`,
    );

    // attributes.payments is the array of payment objects on the intent
    const payments = result.data?.attributes?.payments ?? [];
    res.json({ data: payments });
  } catch (err) {
    console.error("Payments fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/subscriptions/:id/payments", async (req, res) => {
  try {
    const subId = req.params.id;
    let allPayments = [];
    let after = null;

    while (true) {
      let url = `${BASE_URL}/payments?limit=50&filter[subscription_id]=${encodeURIComponent(subId)}`;
      if (after) url += `&after=${after}`;
      const result = await paymongGet(url);
      const batch = result.data || [];
      allPayments.push(...batch);
      if (result.has_more && batch.length > 0) {
        after = batch[batch.length - 1].id;
      } else {
        break;
      }
    }

    allPayments.sort((a, b) => (b.attributes.created_at || 0) - (a.attributes.created_at || 0));
    res.json({ data: allPayments });
  } catch (err) {
    console.error("Sub payments fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
