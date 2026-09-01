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
    // Cap page size: PayMongo's subscriptions endpoint returns 408 when a page
    // takes longer than its ~5s server-side timeout to compute (limit=50 ≈ 5s+).
    const { limit = 20, after, before, status } = req.query;
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

// Cache to prevent fetching all subscriptions repeatedly
let searchCache = {
  timestamp: 0,
  data: []
};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get("/api/search", async (req, res) => {
  try {
    const query = (req.query.q || "").trim();
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const lowerQuery = query.toLowerCase();

    // --- Direct ID Searches (Fast Path) ---
    // 1. Payment Intent ID
    if (query.startsWith("pi_")) {
      try {
        const piRes = await paymongGet(`${BASE_URL}/payment_intents/${query}`);
        const desc = piRes.data?.attributes?.description || "";
        const match = desc.match(/(subs_[a-zA-Z0-9]+)/);
        if (match) {
          const subId = match[1];
          const subRes = await paymongGet(`${BASE_URL}/subscriptions/${subId}`);
          if (subRes.data) return res.json({ data: [subRes.data] });
        }
      } catch (err) {
        console.log("PI search error:", err.message);
      }
      return res.json({ data: [] });
    }

    // 2. Subscription ID
    if (query.startsWith("subs_") || query.startsWith("sub_")) {
      try {
        const subRes = await paymongGet(`${BASE_URL}/subscriptions/${query}`);
        if (subRes.data) return res.json({ data: [subRes.data] });
      } catch (err) {
        console.log("Sub search error:", err.message);
      }
      return res.json({ data: [] });
    }

    // 3. Invoice ID
    if (query.startsWith("inv_")) {
      try {
        const invRes = await paymongGet(`${BASE_URL}/subscriptions/invoices/${query}`);
        const subId = invRes.data?.attributes?.subscription?.id;
        if (subId) {
          const subRes = await paymongGet(`${BASE_URL}/subscriptions/${subId}`);
          if (subRes.data) return res.json({ data: [subRes.data] });
        }
      } catch (err) {
        console.log("Invoice search error:", err.message);
      }
      return res.json({ data: [] });
    }

    // --- Email Search (Slow Path using Cache) ---
    let allSubs = [];
    
    // Use cache if valid
    if (Date.now() - searchCache.timestamp < CACHE_TTL && searchCache.data.length > 0) {
      allSubs = searchCache.data;
    } else {
      let after = null;
      // Fetch all subscriptions to search through. limit=20 prevents PayMongo 408 timeouts.
      while (true) {
        let url = `${BASE_URL}/subscriptions?limit=20`;
        if (after) url += `&after=${after}`;
        const result = await paymongGet(url);
        const batch = result.data || [];
        allSubs.push(...batch);
        if (result.has_more && batch.length > 0) {
          after = batch[batch.length - 1].id;
        } else {
          break;
        }
      }
      
      // Update cache
      searchCache.data = allSubs;
      searchCache.timestamp = Date.now();
    }

    let found = [];

    // It's an email. We need to fetch customers for the subscriptions.
    const uniqueCids = [...new Set(allSubs.map(s => s.attributes.customer_id).filter(Boolean))];
    
    const customerCache = {};
    const BATCH_SIZE = 10;
    for (let i = 0; i < uniqueCids.length; i += BATCH_SIZE) {
      const cids = uniqueCids.slice(i, i + BATCH_SIZE);
      await Promise.all(
        cids.map(async (cid) => {
          try {
            const res = await paymongGet(`${BASE_URL}/customers/${cid}`);
            customerCache[cid] = (res.data?.attributes?.email || "").toLowerCase();
          } catch {
            customerCache[cid] = "";
          }
        })
      );
    }

    found = allSubs.filter(sub => {
      const cid = sub.attributes.customer_id;
      const email = customerCache[cid] || "";
      return email.includes(lowerQuery);
    });

    res.json({ data: found });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
