"""Canonical schema types for DataRefine Studio."""

from __future__ import annotations

from typing import Any, Literal

SCHEMA_TYPES = (
    "Text",
    "Name",
    "Gender",
    "Age",
    "Integer",
    "Decimal",
    "Amount",
    "Currency",
    "Percent",
    "Boolean",
    "Date",
    "DateTime",
    "Time",
    "Year",
    "Month",
    "Email",
    "Phone",
    "URL",
    "Country",
    "City",
    "Postal Code",
    "Address",
    "UUID",
    "Category",
    "JSON",
    "ID",
    "Custom",
)

SchemaType = str


def empty_column_schema(name: str, inferred: str = "Text") -> dict[str, Any]:
    return {
        "name": name,
        "display_name": name,
        "inferred": inferred,
        "active": inferred,
        "manual": False,
        "nullable": True,
        "required": False,
        "unique": False,
        "default": "",
        "validation": "",
        "regex": "",
        "description": "",
        "example": "",
        "preset": "",
        "locked": False,
    }
