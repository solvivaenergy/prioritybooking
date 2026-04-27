require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");

const app = express();

// Capture raw body for PayMongo webhook signature verification (must be before express.json)
app.use(
  "/prioritybooking/webhook/paymongo",
  express.raw({ type: "application/json" }),
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/prioritybooking", express.static(path.join(__dirname, "public")));

const {
  PAYMONGO_SECRET_KEY,
  PAYMONGO_WEBHOOK_SECRET,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  HMAC_SECRET,
  PORT = 3000,
  ODOO_TEMPLATE_CLIENT,
  ODOO_TEMPLATE_SALESREP,
  DASHBOARD_PASSWORD,
} = process.env;

// ─── Helpers ──────────────────────────────────────────────

function generateToken(leadId) {
  return crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(String(leadId))
    .digest("hex");
}

function verifyToken(leadId, token) {
  const expected = generateToken(leadId);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

// Odoo JSON-RPC helper
async function odooRpc(service, method, args) {
  const res = await axios.post(`${ODOO_URL}/jsonrpc`, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "call",
    params: { service, method, args },
  });
  if (res.data.error) {
    throw new Error(
      res.data.error.data?.message ||
        res.data.error.message ||
        "Odoo RPC error",
    );
  }
  return res.data.result;
}

async function odooAuthenticate() {
  return odooRpc("common", "authenticate", [
    ODOO_DB,
    ODOO_USER,
    ODOO_API_KEY,
    {},
  ]);
}

async function odooExecute(model, method, args, kwargs = {}) {
  const uid = await odooAuthenticate();
  return odooRpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    model,
    method,
    args,
    kwargs,
  ]);
}

// ─── Routes ───────────────────────────────────────────────

// Serve T&C page — validates lead_id + token
app.get("/prioritybooking", async (req, res) => {
  const { lead_id, token } = req.query;

  if (!lead_id || !token) {
    return res.status(400).send("Invalid link. Missing parameters.");
  }

  // Verify HMAC token
  try {
    if (!verifyToken(lead_id, token)) {
      return res.status(403).send("Invalid or tampered link.");
    }
  } catch {
    return res.status(403).send("Invalid or tampered link.");
  }

  // Check lead exists and hasn't already agreed
  try {
    const leads = await odooExecute(
      "crm.lead",
      "search_read",
      [[["id", "=", parseInt(lead_id, 10)]]],
      { fields: ["id", "partner_name", "x_studio_tc_agreed"], limit: 1 },
    );

    if (!leads || leads.length === 0) {
      return res.status(404).send("Lead not found.");
    }

    if (leads[0].x_studio_tc_agreed) {
      return res
        .status(400)
        .send(
          "You have already agreed to the Terms & Conditions for this booking.",
        );
    }
  } catch (err) {
    console.error("Odoo lookup error:", err.message);
    // Still serve the page — the submission will re-validate
  }

  // Serve the T&C page
  res.sendFile(path.join(__dirname, "public", "priority-booking.html"));
});

// Handle T&C form submission
app.post("/prioritybooking/api/submit-tc", async (req, res) => {
  const { lead_id, token, name, address, date, signature } = req.body;

  // ── 1. Validate inputs ──
  if (!lead_id || !token || !name || !address || !date || !signature) {
    return res.status(400).json({ error: "All fields are required." });
  }

  try {
    if (!verifyToken(lead_id, token)) {
      return res.status(403).json({ error: "Invalid or tampered link." });
    }
  } catch {
    return res.status(403).json({ error: "Invalid or tampered link." });
  }

  // Check not already submitted
  try {
    const leads = await odooExecute(
      "crm.lead",
      "search_read",
      [[["id", "=", parseInt(lead_id, 10)]]],
      { fields: ["id", "x_studio_tc_agreed"], limit: 1 },
    );
    if (!leads || leads.length === 0) {
      return res.status(404).json({ error: "Lead not found." });
    }
    if (leads[0].x_studio_tc_agreed) {
      return res.status(400).json({
        error: "Already submitted. Check your email for the payment link.",
      });
    }
  } catch (err) {
    console.error("Odoo check error:", err.message);
    return res
      .status(500)
      .json({ error: "Unable to verify lead status. Please try again." });
  }

  // ── 2. Create PayMongo Link ──
  let paymongoData;
  try {
    const pmResponse = await axios.post(
      "https://api.paymongo.com/v1/links",
      {
        data: {
          attributes: {
            amount: 500000, // ₱5,000 in centavos
            description: `Solviva Energy - Priority Booking Fee for ${name}`,
            remarks: `Odoo Lead ID: ${lead_id}`,
          },
        },
      },
      {
        auth: { username: PAYMONGO_SECRET_KEY, password: "" },
        headers: { "Content-Type": "application/json" },
      },
    );
    paymongoData = pmResponse.data.data;
  } catch (err) {
    console.error("PayMongo error:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: "Failed to create payment link. Please try again." });
  }

  const linkId = paymongoData.id;
  const refNumber = paymongoData.attributes.reference_number;
  const checkoutUrl = paymongoData.attributes.checkout_url;

  console.log("PayMongo Link created:", { linkId, refNumber, checkoutUrl });

  // ── 3. Update Odoo Lead ──
  // Extract base64 data from data URL (remove "data:image/png;base64," prefix)
  const signatureBase64 = signature.replace(/^data:image\/\w+;base64,/, "");

  try {
    await odooExecute("crm.lead", "write", [
      [parseInt(lead_id, 10)],
      {
        x_studio_paymongo_link_id: linkId,
        x_studio_paymongo_ref: refNumber,
        x_studio_paymongo_checkout_url: checkoutUrl,
        x_studio_tc_agreed: true,
        x_studio_tc_name: name,
        x_studio_tc_address: address,
        x_studio_tc_date: date,
        x_studio_tc_signature: signatureBase64,
        x_studio_tc_agreed_datetime: new Date()
          .toISOString()
          .replace("T", " ")
          .substring(0, 19),
      },
    ]);
  } catch (err) {
    console.error("Odoo update error:", err.message);
    // Payment link was already created — still redirect the client
    // The n8n batch will reconcile later
  }

  // ── 4. Return checkout URL for redirect ──
  res.json({ checkout_url: checkoutUrl, reference_number: refNumber });
});

// ─── PayMongo Webhook — Real-time payment sync ───────────

app.post("/prioritybooking/webhook/paymongo", async (req, res) => {
  // ── Verify PayMongo webhook signature ──
  const sigHeader = req.headers["paymongo-signature"];
  if (!sigHeader || !PAYMONGO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Missing signature" });
  }

  try {
    const parts = Object.fromEntries(
      sigHeader.split(",").map((p) => p.split("=")),
    );
    const timestamp = parts.t;
    const receivedSig = parts.te || parts.li; // te = test, li = live
    const rawBody =
      req.body instanceof Buffer
        ? req.body.toString()
        : JSON.stringify(req.body);
    const expectedSig = crypto
      .createHmac("sha256", PAYMONGO_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    if (
      !crypto.timingSafeEqual(
        Buffer.from(expectedSig),
        Buffer.from(receivedSig),
      )
    ) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  } catch {
    return res.status(401).json({ error: "Signature verification failed" });
  }

  const event = JSON.parse(
    req.body instanceof Buffer ? req.body.toString() : JSON.stringify(req.body),
  );

  // Respond immediately so PayMongo doesn't retry
  res.json({ received: true });

  try {
    const eventType = event?.data?.attributes?.type;
    if (eventType !== "link.payment.paid") {
      console.log("Webhook ignored, event type:", eventType);
      return;
    }

    const linkData = event.data.attributes.data;
    const linkId = linkData?.id;
    const paymentId = linkData?.attributes?.payments?.[0]?.id || "";

    if (!linkId) {
      console.error("Webhook: No link ID in payload");
      return;
    }

    console.log(`Webhook received: ${eventType} for link ${linkId}`);

    // Find the Odoo lead with this PayMongo link ID
    const leads = await odooExecute(
      "crm.lead",
      "search_read",
      [[["x_studio_paymongo_link_id", "=", linkId]]],
      { fields: ["id", "x_studio_priority_booking_paid"], limit: 1 },
    );

    if (!leads || leads.length === 0) {
      console.error(`Webhook: No lead found for link ${linkId}`);
      return;
    }

    const lead = leads[0];
    if (lead.x_studio_priority_booking_paid) {
      console.log(`Webhook: Lead ${lead.id} already marked as paid, skipping`);
      return;
    }

    // Update lead as paid
    await odooExecute("crm.lead", "write", [
      [lead.id],
      {
        x_studio_priority_booking_paid: true,
        x_studio_priority_booking_amount: 5000,
      },
    ]);

    console.log(
      `Webhook: Lead ${lead.id} marked as PAID (payment: ${paymentId})`,
    );

    // ── Send emails via Odoo mail templates ──
    const sendTemplate = async (templateId, leadId, label) => {
      if (!templateId) {
        console.warn(`Webhook: No template ID for ${label}, skipping`);
        return;
      }
      await odooExecute(
        "mail.template",
        "send_mail",
        [parseInt(templateId), leadId],
        { force_send: true },
      );
      console.log(`Webhook: ${label} email sent via template ${templateId}`);
    };

    await sendTemplate(ODOO_TEMPLATE_CLIENT, lead.id, "client");
    await sendTemplate(ODOO_TEMPLATE_SALESREP, lead.id, "sales rep");
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

// ─── Dashboard ─────────────────────────────────────────────────────────────

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0) {
      cookies[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
    }
  });
  return cookies;
}

function getDashboardToken() {
  return crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(`dashboard:${DASHBOARD_PASSWORD}`)
    .digest("hex");
}

function checkDashboardAuth(req) {
  if (!DASHBOARD_PASSWORD) return false;
  const expected = getDashboardToken();
  // Accept Authorization: Bearer <token>
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Also accept legacy cookie
  const cookie = parseCookies(req).db_session || "";
  const token = bearer || cookie;
  if (!token) return false;
  try {
    return (
      token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

function requireDashboardAuth(req, res, next) {
  if (checkDashboardAuth(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// Serve dashboard HTML
app.get("/prioritybooking/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Login
app.post("/prioritybooking/dashboard/auth", (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).json({ error: "Dashboard not configured" });
  }
  const { password } = req.body;
  if (!password || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = getDashboardToken();
  res.json({ ok: true, token });
});

// Logout
app.get("/prioritybooking/dashboard/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "db_session=; Path=/prioritybooking; HttpOnly; Max-Age=0",
  );
  res.redirect("/prioritybooking/dashboard");
});

// API: leads with T&C link
app.get(
  "/prioritybooking/api/dashboard/leads",
  requireDashboardAuth,
  async (req, res) => {
    try {
      const leads = await odooExecute(
        "crm.lead",
        "search_read",
        [[["x_studio_tc_link", "!=", false]]],
        {
          fields: [
            "id",
            "partner_name",
            "contact_name",
            "stage_id",
            "x_studio_tc_link",
            "x_studio_tc_agreed",
            "x_studio_tc_agreed_datetime",
            "x_studio_paymongo_checkout_url",
            "x_studio_priority_booking_paid",
          ],
          order: "id desc",
          limit: 500,
        },
      );
      res.json({ leads: leads.filter((l) => l.x_studio_tc_link) });
    } catch (err) {
      console.error("Dashboard leads error:", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// API: generate booking URLs and save to Odoo
app.post(
  "/prioritybooking/api/dashboard/generate-urls",
  requireDashboardAuth,
  async (req, res) => {
    const { lead_ids } = req.body;
    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "lead_ids must be a non-empty array" });
    }
    const results = [];
    for (const raw of lead_ids) {
      const id = parseInt(raw, 10);
      if (isNaN(id)) {
        results.push({ id: raw, error: "Invalid ID" });
        continue;
      }
      const url = `https://solvivaenergy.com/prioritybooking?lead_id=${id}&token=${generateToken(id)}`;
      try {
        const found = await odooExecute(
          "crm.lead",
          "search_read",
          [[["id", "=", id]]],
          {
            fields: [
              "id",
              "partner_name",
              "contact_name",
              "x_studio_tc_agreed",
              "x_studio_priority_booking_paid",
            ],
            limit: 1,
          },
        );
        if (!found || found.length === 0) {
          results.push({ id, url, error: "Lead not found" });
          continue;
        }
        const lead = found[0];
        await odooExecute("crm.lead", "write", [
          [id],
          { x_studio_tc_link: url },
        ]);
        results.push({
          id,
          name: lead.partner_name || lead.contact_name || "",
          url,
          saved: true,
          tc_agreed: lead.x_studio_tc_agreed,
          paid: lead.x_studio_priority_booking_paid,
        });
      } catch (err) {
        results.push({ id, url, error: err.message, saved: false });
      }
    }
    res.json({ results });
  },
);

// API: reset all priority booking fields on a lead
app.post(
  "/prioritybooking/api/dashboard/reset-lead",
  requireDashboardAuth,
  async (req, res) => {
    const id = parseInt(req.body.lead_id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid lead_id" });
    try {
      const found = await odooExecute(
        "crm.lead",
        "search_read",
        [[["id", "=", id]]],
        { fields: ["id", "partner_name", "contact_name"], limit: 1 },
      );
      if (!found || found.length === 0)
        return res.status(404).json({ error: "Lead not found" });
      await odooExecute("crm.lead", "write", [
        [id],
        {
          x_studio_tc_link: false,
          x_studio_tc_agreed: false,
          x_studio_tc_name: false,
          x_studio_tc_address: false,
          x_studio_tc_date: false,
          x_studio_tc_signature: false,
          x_studio_tc_agreed_datetime: false,
          x_studio_paymongo_link_id: false,
          x_studio_paymongo_ref: false,
          x_studio_paymongo_checkout_url: false,
          x_studio_priority_booking_paid: false,
          x_studio_priority_booking_amount: false,
        },
      ]);
      const lead = found[0];
      res.json({
        ok: true,
        name: lead.partner_name || lead.contact_name || "",
      });
    } catch (err) {
      console.error("Reset lead error:", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Health check
app.get("/prioritybooking/health", (req, res) => res.json({ status: "ok" }));

// ─── Start ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Priority Booking server running on http://localhost:${PORT}`);
});
