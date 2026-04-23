require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/prioritybooking", express.static(path.join(__dirname, "public")));

const {
  PAYMONGO_SECRET_KEY,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  HMAC_SECRET,
  PORT = 3000,
  ODOO_TEMPLATE_CLIENT,
  ODOO_TEMPLATE_SALESREP,
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
  const event = req.body;

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
      await odooExecute("mail.template", "send_mail", [
        parseInt(templateId),
        leadId,
        { force_send: true },
      ]);
      console.log(`Webhook: ${label} email sent via template ${templateId}`);
    };

    await sendTemplate(ODOO_TEMPLATE_CLIENT, lead.id, "client");
    await sendTemplate(ODOO_TEMPLATE_SALESREP, lead.id, "sales rep");
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

// Health check
app.get("/prioritybooking/health", (req, res) => res.json({ status: "ok" }));

// ─── Start ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Priority Booking server running on http://localhost:${PORT}`);
});
