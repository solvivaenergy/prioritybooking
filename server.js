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
      {
        fields: [
          "id",
          "name",
          "email_from",
          "user_id",
          "x_studio_priority_booking_paid",
          "x_studio_tc_name",
          "x_studio_tc_address",
          "x_studio_paymongo_ref",
        ],
        limit: 1,
      },
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

    // ── Send confirmation emails via Odoo mail.mail ──
    const clientName    = lead.x_studio_tc_name || lead.name || "Client";
    const clientEmail   = lead.email_from || "";
    const projectSite   = lead.x_studio_tc_address || "—";
    const paymongoRef   = lead.x_studio_paymongo_ref || "—";

    // Fetch sales rep email from res.users
    let salesRepName  = "";
    let salesRepEmail = "";
    if (Array.isArray(lead.user_id) && lead.user_id[0]) {
      try {
        const users = await odooExecute("res.users", "read", [
          [lead.user_id[0]],
          ["name", "email"],
        ]);
        if (users && users[0]) {
          salesRepName  = users[0].name  || "";
          salesRepEmail = users[0].email || "";
        }
      } catch (e) {
        console.error("Webhook: Could not fetch sales rep email:", e.message);
      }
    }

    // ── Email 1: Client confirmation ──
    if (clientEmail) {
      const clientBody = `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
          <div style="background:#006ac6;padding:28px 32px;text-align:center;">
            <img src="https://solvivaenergy.com/prioritybooking/solviva-logo.svg" alt="Solviva" style="height:44px;" />
          </div>
          <div style="padding:32px;">
            <h2 style="color:#344054;font-size:22px;margin:0 0 8px;">Payment Confirmed!</h2>
            <p style="color:#344054;font-size:16px;margin:0 0 24px;">Hi <strong>${clientName}</strong>, your Priority Booking fee has been received.</p>
            <div style="background:#eef3fb;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
              <table style="width:100%;font-size:15px;color:#344054;border-collapse:collapse;">
                <tr><td style="padding:6px 0;color:#6b7280;">Reference No.</td><td style="padding:6px 0;font-weight:600;text-align:right;">${paymongoRef}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Amount Paid</td><td style="padding:6px 0;font-weight:600;text-align:right;">₱5,000.00</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Project Site</td><td style="padding:6px 0;font-weight:600;text-align:right;">${projectSite}</td></tr>
              </table>
            </div>
            <p style="color:#344054;font-size:15px;line-height:1.6;">Our team will reach out within <strong>5 Business Days</strong> to schedule your site assessment. If you have any questions, reply to this email or contact your sales representative${salesRepName ? ` <strong>${salesRepName}</strong>` : ""}.</p>
            <p style="color:#6b7280;font-size:13px;margin-top:24px;">The ₱5,000.00 Priority Booking Fee will be credited toward your final Contract Price.</p>
          </div>
          <div style="background:#f9fafb;padding:16px 32px;text-align:center;">
            <p style="color:#9ca3af;font-size:12px;margin:0;">Solviva Energy Incorporated &bull; solvivaenergy.com</p>
          </div>
        </div>`;

      const clientMailId = await odooExecute("mail.mail", "create", [{
        subject: `Priority Booking Confirmed — Ref. ${paymongoRef}`,
        body_html: clientBody,
        email_to: clientEmail,
        email_from: "noreply@solvivaenergy.com",
        auto_delete: true,
      }]);
      await odooExecute("mail.mail", "send", [[clientMailId]]);
      console.log(`Webhook: Client email sent to ${clientEmail}`);
    } else {
      console.warn(`Webhook: No client email on lead ${lead.id}, skipping client email`);
    }

    // ── Email 2: Sales rep notification ──
    if (salesRepEmail) {
      const repBody = `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
          <div style="background:#1f522b;padding:28px 32px;text-align:center;">
            <img src="https://solvivaenergy.com/prioritybooking/solviva-logo.svg" alt="Solviva" style="height:44px;filter:brightness(0) invert(1);" />
          </div>
          <div style="padding:32px;">
            <h2 style="color:#344054;font-size:22px;margin:0 0 8px;">Priority Booking Paid</h2>
            <p style="color:#344054;font-size:16px;margin:0 0 24px;">Hi <strong>${salesRepName}</strong>, a client assigned to you has completed their Priority Booking payment.</p>
            <div style="background:#eef3fb;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
              <table style="width:100%;font-size:15px;color:#344054;border-collapse:collapse;">
                <tr><td style="padding:6px 0;color:#6b7280;">Client Name</td><td style="padding:6px 0;font-weight:600;text-align:right;">${clientName}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Client Email</td><td style="padding:6px 0;font-weight:600;text-align:right;">${clientEmail}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Reference No.</td><td style="padding:6px 0;font-weight:600;text-align:right;">${paymongoRef}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Amount Paid</td><td style="padding:6px 0;font-weight:600;text-align:right;">₱5,000.00</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Project Site</td><td style="padding:6px 0;font-weight:600;text-align:right;">${projectSite}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Odoo Lead ID</td><td style="padding:6px 0;font-weight:600;text-align:right;">${lead.id}</td></tr>
              </table>
            </div>
            <p style="color:#344054;font-size:15px;line-height:1.6;">Please schedule the site assessment within <strong>5 Business Days</strong> and coordinate with the client.</p>
          </div>
          <div style="background:#f9fafb;padding:16px 32px;text-align:center;">
            <p style="color:#9ca3af;font-size:12px;margin:0;">Solviva Energy Incorporated &bull; solvivaenergy.com</p>
          </div>
        </div>`;

      const repMailId = await odooExecute("mail.mail", "create", [{
        subject: `[Priority Booking Paid] ${clientName} — Ref. ${paymongoRef}`,
        body_html: repBody,
        email_to: salesRepEmail,
        email_from: "noreply@solvivaenergy.com",
        auto_delete: true,
      }]);
      await odooExecute("mail.mail", "send", [[repMailId]]);
      console.log(`Webhook: Sales rep email sent to ${salesRepEmail}`);
    } else {
      console.warn(`Webhook: No sales rep email for lead ${lead.id}, skipping rep email`);
    }

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
