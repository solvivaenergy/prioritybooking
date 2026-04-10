# Priority Booking — System Architecture

## 1. Overview

Qualified Odoo CRM leads receive an email offering priority booking (₱5,000 upfront, deducted from total bill). The email links to a Terms & Conditions page where clients provide their name, address, signature, and date. Upon agreement, a PayMongo payment link is generated and the client is redirected to pay. An n8n batch job runs every 15 minutes to sync payment statuses back to Odoo.

---

## 2. System Components

```
┌─────────────┐     Email w/ T&C Link      ┌──────────────────────┐
│  Odoo CRM   │ ─────────────────────────► │  Client Email Inbox  │
│  (Leads)    │                             └──────────┬───────────┘
└──────┬──────┘                                        │
       │                                     clicks link
       │                                               │
       │                                               ▼
       │                                  ┌────────────────────────┐
       │                                  │   T&C Web App          │
       │                                  │   (HTML + signature    │
       │                                  │    pad + form fields)  │
       │                                  └──────────┬─────────────┘
       │                                             │
       │                                   submits form
       │                                             │
       │                                             ▼
       │                                  ┌────────────────────────┐
       │                                  │   Backend API          │
       │◄─── writes T&C data + ──────────│   (Node.js / Python)   │
       │     PayMongo ref to lead         │                        │
       │                                  └──────────┬─────────────┘
       │                                             │
       │                                  creates PayMongo Link
       │                                             │
       │                                             ▼
       │                                  ┌────────────────────────┐
       │                                  │   PayMongo             │
       │                                  │   (Payment Link)       │
       │                                  └──────────┬─────────────┘
       │                                             │
       │                                  client pays on PayMongo
       │                                             │
       │         ┌───────────────┐                   │
       │◄────────│   n8n         │◄──────────────────┘
       │  update │   (every 15   │   polls PayMongo for
       │  lead   │    minutes)   │   paid links
       │  as paid└───────────────┘
       │
       ▼
┌─────────────┐
│  Odoo CRM   │
│  Lead tagged│
│  as PAID    │
└─────────────┘
```

---

## 3. Detailed Flow & Sequence

### Step 1: Email Blast (Odoo → Client)

- **Who triggers:** Marketing team via Odoo Mass Mailing or manual selection
- **What:** Send email to qualified leads with a personalized link to the T&C page
- **Link format:** `https://your-domain.com/priority-booking?lead_id={odoo_lead_id}&token={secure_token}`
  - `lead_id` — the Odoo CRM lead/opportunity ID
  - `token` — an HMAC-signed token to prevent URL tampering (sign `lead_id` with a server-side secret)
- **No PayMongo link is created yet** — this avoids generating payment links for leads that never engage

### Step 2: T&C Page (Client Browser)

- Client clicks the link from the email
- The web app loads the T&C content (based on your attached document)
- At the bottom of the page, the client fills in:
  - **Full Name** — text input
  - **Complete Address** — text input
  - **Date** — date picker (auto-filled with today's date)
  - **Signature** — `signature_pad` canvas component (see Section 6)
- Client clicks **"I Agree & Proceed to Payment"**

### Step 3: Backend Processing (on T&C Submit)

This is the critical orchestration step. The sequence is:

```
Client submits T&C form
        │
        ▼
┌─────────────────────────────────┐
│ 1. Validate token + lead_id    │
│    (verify HMAC signature)     │
├─────────────────────────────────┤
│ 2. Create PayMongo Link        │
│    POST /v1/links              │
│    amount: 500000 (₱5,000 in   │
│    centavos), description:     │
│    "Priority Booking - {name}" │
│    → Returns: link_id,         │
│      reference_number,         │
│      checkout_url              │
├─────────────────────────────────┤
│ 3. Update Odoo Lead            │
│    via XML-RPC / JSON-RPC      │
│    Set fields:                 │
│    • x_paymongo_link_id        │
│    • x_paymongo_ref            │
│    • x_tc_name                 │
│    • x_tc_address              │
│    • x_tc_date                 │
│    • x_tc_signature (base64)   │
│    • x_tc_agreed = True        │
├─────────────────────────────────┤
│ 4. Redirect client to          │
│    PayMongo checkout_url       │
└─────────────────────────────────┘
```

**Why this order matters:**

- PayMongo link is created **after** T&C agreement so you only pay for links that have real engagement
- Odoo is updated **before** redirect so you have a record even if the client abandons payment
- The PayMongo reference number is written to Odoo immediately, binding the payment to the lead

### Step 4: Client Pays (PayMongo)

- Client is redirected to the PayMongo hosted payment page
- They choose their payment method (credit/debit card, GCash, GrabPay, Maya, online banking, etc.)
- PayMongo handles all payment processing and PCI compliance

### Step 5: Payment Sync — n8n Batch Job (Every 15 Minutes)

- n8n workflow runs on a 15-minute cron schedule
- **Process:**
  1. **Query Odoo:** Get all leads where `x_tc_agreed = True` AND `x_priority_booking_paid = False` AND `x_paymongo_link_id` is not empty
  2. **For each lead:** Call PayMongo API `GET /v1/links/{link_id}` to check the link status
  3. **If status = "paid":** Update the Odoo lead → set `x_priority_booking_paid = True`
  4. **(Optional)** Store the PayMongo payment ID on the lead for audit trail

```
n8n Workflow (Cron: */15 * * * *)
        │
        ▼
  Query Odoo for unpaid leads
  with PayMongo ref
        │
        ▼
  Loop: For each lead
        │
        ├──► GET PayMongo /v1/links/{link_id}
        │
        ├──► If status == "paid"
        │       │
        │       ▼
        │    Update Odoo lead:
        │    x_priority_booking_paid = True
        │
        └──► Next lead
```

---

## 4. Odoo CRM — Custom Fields on Lead/Opportunity

Add these custom fields to `crm.lead` in Odoo:

| Field Name                  | Type     | Description                                              |
| --------------------------- | -------- | -------------------------------------------------------- |
| `x_paymongo_link_id`        | Char     | PayMongo Link ID (e.g., `link_wWaibr22CzEnficNhQNPUdoo`) |
| `x_paymongo_ref`            | Char     | PayMongo reference number (e.g., `WTmSJbV`)              |
| `x_paymongo_checkout_url`   | Char     | The PayMongo payment URL                                 |
| `x_priority_booking_paid`   | Boolean  | Whether the client has paid the ₱5,000                   |
| `x_priority_booking_amount` | Float    | Amount paid (default: 5000.00)                           |
| `x_tc_agreed`               | Boolean  | Whether the client agreed to T&C                         |
| `x_tc_name`                 | Char     | Name provided on T&C form                                |
| `x_tc_address`              | Text     | Address provided on T&C form                             |
| `x_tc_date`                 | Date     | Date of T&C agreement                                    |
| `x_tc_signature`            | Binary   | Signature image (base64 PNG from signature_pad)          |
| `x_tc_agreed_datetime`      | Datetime | Exact timestamp of T&C agreement                         |

These can be added via **Odoo Studio** (no-code) or as a custom module.

---

## 5. API Specifications

### 5.1 PayMongo — Create a Link

```
POST https://api.paymongo.com/v1/links
Authorization: Basic base64(<YOUR_PAYMONGO_SECRET_KEY>:)
Content-Type: application/json

{
  "data": {
    "attributes": {
      "amount": 500000,
      "description": "EV Legal - Priority Booking Fee - {Lead Name}",
      "remarks": "Odoo Lead ID: {lead_id}"
    }
  }
}
```

**Response (key fields):**

```json
{
  "data": {
    "id": "link_xxxxxxxxxx",
    "attributes": {
      "amount": 500000,
      "checkout_url": "https://pm.link/...",
      "reference_number": "WTmSJbV",
      "status": "unpaid"
    }
  }
}
```

### 5.2 PayMongo — Retrieve a Link (for payment status check)

```
GET https://api.paymongo.com/v1/links/{link_id}
Authorization: Basic base64(<YOUR_PAYMONGO_SECRET_KEY>:)
```

**Check:** `data.attributes.status` → `"unpaid"` or `"paid"`

### 5.3 PayMongo — Get Link by Reference Number (alternative)

```
GET https://api.paymongo.com/v1/links?reference_number={ref}
Authorization: Basic base64(<YOUR_PAYMONGO_SECRET_KEY>:)
```

### 5.4 Odoo — XML-RPC Update Lead

```python
import xmlrpc.client

url = "https://solviva-energy.odoo.com"
db = "solviva-energy"
uid = 2  # authenticate first
api_key = "<YOUR_ODOO_API_KEY>"

models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
models.execute_kw(db, uid, api_key, 'crm.lead', 'write', [[lead_id], {
    'x_paymongo_link_id': 'link_xxxxxxxxxx',
    'x_paymongo_ref': 'WTmSJbV',
    'x_paymongo_checkout_url': 'https://pm.link/...',
    'x_tc_agreed': True,
    'x_tc_name': 'Juan Dela Cruz',
    'x_tc_address': '123 Main St, Makati City',
    'x_tc_date': '2026-04-07',
    'x_tc_signature': '<base64_png_data>',
    'x_tc_agreed_datetime': '2026-04-07 10:30:00',
}])
```

---

## 6. Signature Component — `signature_pad`

Use the **[signature_pad](https://github.com/szimek/signature_pad)** JavaScript library. It renders an HTML5 Canvas that captures hand-drawn signatures (works on both desktop mouse and mobile touch).

### Integration:

```html
<script src="https://cdn.jsdelivr.net/npm/signature_pad@4.2.0/dist/signature_pad.umd.min.js"></script>

<div class="signature-section">
  <label>Signature of Subscriber:</label>
  <canvas
    id="signature-canvas"
    width="500"
    height="200"
    style="border: 1px solid #ccc; border-radius: 4px;"
  ></canvas>
  <br />
  <button type="button" onclick="signaturePad.clear()">Clear Signature</button>
</div>

<script>
  const canvas = document.getElementById("signature-canvas");
  const signaturePad = new SignaturePad(canvas, {
    backgroundColor: "rgb(255, 255, 255)",
    penColor: "rgb(0, 0, 0)",
  });

  // On form submit, extract signature as base64 PNG:
  function getSignatureData() {
    if (signaturePad.isEmpty()) {
      alert("Please provide your signature.");
      return null;
    }
    return signaturePad.toDataURL("image/png"); // base64 PNG string
  }
</script>
```

The `toDataURL()` output is a base64-encoded PNG that can be:

- Sent to the backend in the form submission payload
- Stored in Odoo's Binary field (`x_tc_signature`)
- Rendered back as an image anytime for verification

---

## 7. n8n Workflow Design

### Workflow: "Priority Booking — Payment Sync"

**Trigger:** Cron node — every 15 minutes (`*/15 * * * *`)

**Nodes:**

1. **Cron Trigger** → Every 15 minutes
2. **Odoo Node** → Search `crm.lead` where:
   - `x_tc_agreed` = True
   - `x_priority_booking_paid` = False
   - `x_paymongo_link_id` != ""
3. **Loop / SplitInBatches** → For each lead
4. **HTTP Request** → `GET https://api.paymongo.com/v1/links/{link_id}`
   - Auth: Basic (secret key as username, empty password)
5. **IF Node** → Check `data.attributes.status == "paid"`
6. **Odoo Node** (update) → Set `x_priority_booking_paid = True` on the lead
7. **(Optional) Odoo Node** → Log the payment details (payment_id, paid_at)

### Alternative: PayMongo Webhook (Recommended Addition)

PayMongo supports the `link.payment.paid` webhook event. You can set up a webhook in PayMongo that calls an n8n webhook node for **real-time** payment confirmation, while keeping the 15-minute batch as a **fallback** for any missed webhooks.

```
PayMongo Webhook → n8n Webhook Node → Parse payload → Update Odoo Lead
```

This gives you near-instant updates plus guaranteed eventual consistency.

---

## 8. Email Template (Odoo)

The email sent to qualified leads should contain:

- Subject: **"You're Invited: EV Legal Priority Booking"**
- Body highlights:
  - What priority booking means (priority in queue, ₱5,000 deducted from total)
  - Call to action button: **"Review Terms & Reserve Your Spot"**
  - Link: `https://your-domain.com/priority-booking?lead_id={lead.id}&token={hmac_token}`

The `lead_id` and `token` are generated per-lead. The token prevents anyone from guessing URLs.

---

## 9. Security Considerations

| Concern                           | Mitigation                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| URL tampering (spoofed `lead_id`) | HMAC-signed token in URL; server validates before processing                                 |
| Replaying a T&C submission        | Check if `x_tc_agreed` is already True; reject duplicates                                    |
| API keys exposure                 | Store PayMongo & Odoo keys server-side only (env vars); never expose in frontend             |
| Signature forgery                 | Signature is timestamped and tied to a specific lead_id; stored as binary in Odoo            |
| Payment status spoofing           | Always verify payment status server-side via PayMongo API; never trust client-side callbacks |

---

## 10. Tech Stack Summary

| Component             | Technology                                   | Purpose                                       |
| --------------------- | -------------------------------------------- | --------------------------------------------- |
| CRM & Lead Management | Odoo 18.0 (Odoo.sh)                          | Lead records, custom fields, email blast      |
| T&C Web Page          | HTML/CSS/JS (static site or lightweight app) | Display T&C, capture form + signature         |
| Backend API           | Node.js (Express) or Python (Flask/FastAPI)  | Orchestrate T&C → PayMongo → Odoo             |
| Signature Capture     | `signature_pad` (JS library)                 | Canvas-based signature drawing                |
| Payment Processing    | PayMongo Links API                           | Generate payment links, process payments      |
| Workflow Automation   | n8n                                          | 15-min batch sync + optional webhook receiver |
| Hosting (Web App)     | Vercel, Railway, or any VPS                  | Host the T&C page + backend API               |

---

## 11. Data Flow Summary

```
                    EMAIL                T&C PAGE              BACKEND                PAYMONGO              ODOO
                      │                    │                     │                      │                    │
  Odoo sends email    │                    │                     │                      │                    │
  with T&C link ──────┼──────────────────► │                     │                      │                    │
                      │                    │                     │                      │                    │
  Client fills form   │                    │ ──── POST form ───► │                      │                    │
  + signs             │                    │     data            │                      │                    │
                      │                    │                     │                      │                    │
                      │                    │                     │ ── Create Link ─────► │                    │
                      │                    │                     │                      │                    │
                      │                    │                     │ ◄─ link_id + ref ──── │                    │
                      │                    │                     │                      │                    │
                      │                    │                     │ ── Update lead ──────────────────────────► │
                      │                    │                     │    (ref, T&C data)   │                    │
                      │                    │                     │                      │                    │
                      │                    │ ◄── redirect to ─── │                      │                    │
                      │                    │     checkout_url    │                      │                    │
                      │                    │                     │                      │                    │
  Client pays         │                    │ ─────────────────────────────────────────► │                    │
                      │                    │                     │                      │                    │
                      │                    │                     │                      │                    │
  n8n (every 15 min)  │                    │                     │ ── GET link status ─► │                    │
                      │                    │                     │                      │                    │
                      │                    │                     │ ◄─ status: paid ──── │                    │
                      │                    │                     │                      │                    │
                      │                    │                     │ ── Set paid=True ────────────────────────► │
```

---

## 12. Implementation Order (Recommended)

1. **Add custom fields to Odoo** (`crm.lead`) — via Odoo Studio or custom module
2. **Build the T&C web page** — static HTML with `signature_pad`, form fields, styled with brand colors
3. **Build the backend API** — endpoint to handle T&C submission, create PayMongo link, update Odoo
4. **Test PayMongo link creation** — use TEST API keys first (`sk_test_...`, `pk_test_...`)
5. **Set up n8n workflow** — 15-minute cron to sync payment status
6. **Configure Odoo email template** — with personalized T&C links for each lead
7. **End-to-end testing** with test keys
8. **Go live** — switch to LIVE PayMongo keys

---

## 13. Cost & Limits

- **PayMongo fees:** Standard processing fees apply per transaction (varies by payment method)
- **PayMongo Links:** No limit on creating links via API
- **n8n:** Self-hosted is free; cloud plans have execution limits
- **Odoo API:** No rate limits for reasonable usage via XML-RPC
