"""
reset_lead.py — Clears all priority booking fields on an Odoo lead for retesting.

Usage:
    python reset_lead.py <lead_id>

Example:
    python reset_lead.py 1121
"""

import sys
import os
import xmlrpc.client
from dotenv import load_dotenv

load_dotenv()

ODOO_URL = os.getenv("ODOO_URL")
ODOO_DB = os.getenv("ODOO_DB")
ODOO_USER = os.getenv("ODOO_USER")
ODOO_API_KEY = os.getenv("ODOO_API_KEY")

if len(sys.argv) < 2:
    print("Usage: python reset_lead.py <lead_id>")
    sys.exit(1)

lead_id = int(sys.argv[1])

# Authenticate
common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
if not uid:
    print("Authentication failed.")
    sys.exit(1)

models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

# Verify lead exists
leads = models.execute_kw(
    ODOO_DB, uid, ODOO_API_KEY,
    "crm.lead", "search_read",
    [[("id", "=", lead_id)]],
    {
        "fields": [
            "id", "partner_name",
            "x_studio_tc_link",
            "x_studio_tc_agreed",
            "x_studio_paymongo_link_id",
            "x_studio_priority_booking_paid",
        ],
        "limit": 1,
    },
)

if not leads:
    print(f"Lead {lead_id} not found.")
    sys.exit(1)

lead = leads[0]
print(f"Lead found: [{lead['id']}] {lead.get('partner_name', '(no name)')}")
print(f"  tc_link              : {lead.get('x_studio_tc_link')}")
print(f"  tc_agreed            : {lead.get('x_studio_tc_agreed')}")
print(f"  paymongo_link_id     : {lead.get('x_studio_paymongo_link_id')}")
print(f"  priority_booking_paid: {lead.get('x_studio_priority_booking_paid')}")

confirm = input("\nReset all priority booking fields for this lead? (y/N): ").strip().lower()
if confirm != "y":
    print("Aborted.")
    sys.exit(0)

# Clear all priority booking fields
result = models.execute_kw(
    ODOO_DB, uid, ODOO_API_KEY,
    "crm.lead", "write",
    [
        [lead_id],
        {
            # T&C fields
            "x_studio_tc_link": False,
            "x_studio_tc_agreed": False,
            "x_studio_tc_name": False,
            "x_studio_tc_address": False,
            "x_studio_tc_date": False,
            "x_studio_tc_signature": False,
            "x_studio_tc_agreed_datetime": False,
            # PayMongo fields
            "x_studio_paymongo_link_id": False,
            "x_studio_paymongo_ref": False,
            "x_studio_paymongo_checkout_url": False,
            # Payment status
            "x_studio_priority_booking_paid": False,
            "x_studio_priority_booking_amount": False,
        },
    ],
)

if result:
    print(f"\nLead {lead_id} has been reset. You can now retest with:")
    print(
        f'  node -e "const crypto=require(\'crypto\');require(\'dotenv\').config();'
        f"const id='{lead_id}';console.log('https://solvivaenergy.com/prioritybooking"
        f"?lead_id='+id+'&token='+crypto.createHmac('sha256',process.env.HMAC_SECRET)"
        f".update(id).digest('hex'))\"",
    )
else:
    print("Write returned False — no changes were made (field may not exist or no permission).")
