require("dotenv").config();
const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = 3000;
const API_KEY = process.env.PAYMONGO_API_KEY;
const BASE_URL = process.env.PAYMONGO_BASE_URL || "https://api.paymongo.com/v1";
const AUTH = "Basic " + Buffer.from(API_KEY + ":").toString("base64");

app.use(express.static(path.join(__dirname)));

function paymongGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        Authorization: AUTH,
        "Content-Type": "application/json",
      },
    };
    https
      .get(url, options, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(
              new Error(`PayMongo error ${res.statusCode}: ${raw}`),
            );
          }
          resolve(JSON.parse(raw));
        });
      })
      .on("error", reject);
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
// The payment intent attributes.payments[] contain source.brand, source.last4, etc.
app.get("/api/payments", async (req, res) => {
  try {
    const { payment_intent_id } = req.query;
    if (!payment_intent_id) {
      return res.status(400).json({ error: "payment_intent_id is required" });
    }

    // ✅ Correct endpoint: /v1/payments?payment_intent_id=xxx
    const result = await paymongGet(
      `${BASE_URL}/payments?payment_intent_id=${encodeURIComponent(payment_intent_id)}`,
    );

    // result.data is already the payments array
    res.json({ data: result.data ?? [] });
  } catch (err) {
    console.error("Payments fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
