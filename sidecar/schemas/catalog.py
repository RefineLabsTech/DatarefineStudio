"""Industrial schema templates for the Library.

Built from SCHEMA_TYPES + header aliases (offline). Seeded into
/library/templates so the Schemas tab is never empty.
"""

from __future__ import annotations

from typing import Any

from sidecar.schemas.types import SCHEMA_TYPES

EMAIL_RE = r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$"
PHONE_RE = r"^\+?[0-9]{7,15}$"
URL_RE = r"^https?://\S+$"
UUID_RE = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
ISO_DATE_RE = r"^\d{4}-\d{2}-\d{2}"
COUNTRY_RE = r"^[A-Za-z .'\-]{2,56}$"


def _col(
    name: str,
    typ: str,
    *,
    required: bool = False,
    unique: bool = False,
    regex: str = "",
    description: str = "",
    example: str = "",
) -> dict[str, Any]:
    if typ not in SCHEMA_TYPES:
        raise ValueError(f"Unknown schema type {typ!r} for {name}")
    return {
        "column": name,
        "name": name,
        "type": typ,
        "active": typ,
        "manual": True,
        "required": required,
        "nullable": not required,
        "unique": unique,
        "regex": regex,
        "validation": typ.lower().replace(" ", "_"),
        "description": description,
        "example": example,
    }


def catalog_templates() -> list[dict[str, Any]]:
    return [
        {
            "id": "builtin:crm-contacts",
            "name": "CRM · Contacts",
            "industry": "CRM",
            "builtin": True,
            "description": "People and accounts: name, gender, email, phone, country, signup date. Matches typical CRM / signup extracts.",
            "mapping": [
                _col("id", "ID", unique=True, description="Customer or contact key"),
                _col("full_name", "Name", required=True, example="Fatima Begum"),
                _col("first_name", "Name"),
                _col("last_name", "Name"),
                _col("gender", "Gender", example="Female"),
                _col("email", "Email", required=True, regex=EMAIL_RE, example="fatima@example.com"),
                _col("phone", "Phone", regex=PHONE_RE, example="+8801712345678"),
                _col("company", "Name"),
                _col("country", "Country", regex=COUNTRY_RE, example="Bangladesh"),
                _col("city", "City", example="Dhaka"),
                _col("address", "Address"),
                _col("postal_code", "Postal Code"),
                _col("signup", "Date", regex=ISO_DATE_RE, example="2025-03-03"),
                _col("created_at", "DateTime"),
                _col("status", "Category", example="active"),
            ],
        },
        {
            "id": "builtin:hr-employees",
            "name": "HR · Employees",
            "industry": "HR",
            "builtin": True,
            "description": "Workforce file: identity, contact, department, hire date, compensation.",
            "mapping": [
                _col("employee_id", "ID", required=True, unique=True),
                _col("full_name", "Name", required=True),
                _col("gender", "Gender"),
                _col("email", "Email", regex=EMAIL_RE),
                _col("phone", "Phone", regex=PHONE_RE),
                _col("department", "Category"),
                _col("title", "Text"),
                _col("hire_date", "Date", regex=ISO_DATE_RE),
                _col("salary", "Amount"),
                _col("currency", "Currency", example="USD"),
                _col("country", "Country"),
                _col("city", "City"),
                _col("active", "Boolean"),
            ],
        },
        {
            "id": "builtin:commerce-orders",
            "name": "Commerce · Orders",
            "industry": "Commerce",
            "builtin": True,
            "description": "Order lines: identifiers, customer, quantity, money, status, ship-to country.",
            "mapping": [
                _col("order_id", "ID", required=True),
                _col("order_date", "Date", regex=ISO_DATE_RE),
                _col("customer_id", "ID"),
                _col("customer_name", "Name"),
                _col("customer_email", "Email", regex=EMAIL_RE),
                _col("sku", "ID"),
                _col("quantity", "Integer"),
                _col("amount", "Amount"),
                _col("currency", "Currency"),
                _col("status", "Category"),
                _col("country", "Country"),
                _col("city", "City"),
            ],
        },
        {
            "id": "builtin:finance-ledger",
            "name": "Finance · Ledger",
            "industry": "Finance",
            "builtin": True,
            "description": "Journal / payments: transaction id, booking date, amount, currency, status.",
            "mapping": [
                _col("txn_id", "ID", required=True, unique=True),
                _col("txn_date", "Date", regex=ISO_DATE_RE),
                _col("posted_at", "DateTime"),
                _col("account_id", "ID"),
                _col("description", "Text"),
                _col("amount", "Amount", required=True),
                _col("currency", "Currency", required=True, example="USD"),
                _col("status", "Category"),
                _col("reference", "ID"),
            ],
        },
        {
            "id": "builtin:logistics-address",
            "name": "Logistics · Address",
            "industry": "Logistics",
            "builtin": True,
            "description": "Ship-to / bill-to block: name, phone, street, city, postal code, country.",
            "mapping": [
                _col("name", "Name", required=True),
                _col("phone", "Phone", regex=PHONE_RE),
                _col("email", "Email", regex=EMAIL_RE),
                _col("address", "Address", required=True),
                _col("city", "City"),
                _col("postal_code", "Postal Code"),
                _col("country", "Country", required=True),
            ],
        },
        {
            "id": "builtin:catalog-products",
            "name": "Catalog · Products",
            "industry": "Catalog",
            "builtin": True,
            "description": "SKU master: identifiers, category, price, stock, product URL.",
            "mapping": [
                _col("sku", "ID", required=True, unique=True),
                _col("name", "Text", required=True),
                _col("category", "Category"),
                _col("price", "Amount"),
                _col("currency", "Currency"),
                _col("quantity", "Integer"),
                _col("url", "URL", regex=URL_RE),
                _col("active", "Boolean"),
                _col("uuid", "UUID", regex=UUID_RE),
            ],
        },
    ]


def template_by_name(name: str) -> dict[str, Any] | None:
    want = (name or "").strip().lower()
    for t in catalog_templates():
        if str(t.get("name") or "").lower() == want or str(t.get("id") or "") == name:
            return t
    return None
