#!/usr/bin/env node
/* Sign a bootstrap document for the desktop's discovery flow.

   Default output is the PRODUCTION document format (§4):
     { keyId, version, issuedAt, expiresAt, api, app, endpoints, features, signature }
   The signature is Ed25519 over the CANONICAL JSON of the document WITHOUT
   the `signature` field: object keys sorted recursively, arrays in order,
   no insignificant whitespace, UTF-8.

   Usage:
     node services/internal/cloud-bridge/sign-bootstrap.mjs <apiBaseUrl> [version] [validDays] [--legacy]

   --legacy emits the old 4-line-payload format (configVersion/apiBaseUrl/…),
   still accepted by the desktop as a fallback.

   Reads the private key from services/internal/cloud-bridge/keys.json (MOVE that key into your
   cloud's secret store in production; it must never ship inside the desktop). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = JSON.parse(fs.readFileSync(path.join(here, "keys.json"), "utf8"));

const args = process.argv.slice(2);
const legacy = args.includes("--legacy");
const pos = args.filter((a) => !a.startsWith("--"));

const apiBaseUrl = pos[0];
if (!apiBaseUrl?.startsWith("https://")) {
  console.error("apiBaseUrl must be https://…");
  process.exit(1);
}
const version = Number(pos[1] || 4);
const validDays = Number(pos[2] || 90);
const keyId = keys.keyId || "drs-main-2025";

const issuedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + validDays * 86400000).toISOString();

// raw 32-byte seed -> PKCS8 Ed25519 private key
const seed = Buffer.from(keys.privateHex, "hex");
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const priv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });

/** Canonical JSON: recursively sorted keys, ordered arrays, no whitespace. */
function canonicalize(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

let out;
if (legacy) {
  const payload = `${version}\n${apiBaseUrl}\n${issuedAt}\n${expiresAt}`;
  const signature = crypto.sign(null, Buffer.from(payload), priv).toString("hex");
  out = { configVersion: version, apiBaseUrl, issuedAt, expiresAt, signature };
} else {
  const doc = {
    keyId,
    version,
    issuedAt,
    expiresAt,
    api: { baseUrl: apiBaseUrl, fallbackBaseUrls: [] },
    app: { name: "DataRefine Studio" },
    endpoints: {},
    features: {},
  };
  const signature = crypto.sign(null, Buffer.from(canonicalize(doc), "utf8"), priv).toString("hex");
  out = { ...doc, signature };
}

fs.writeFileSync(path.join(here, "bootstrap.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(
  legacy
    ? "\nLegacy format written. Serve at your bootstrap URL."
    : `\nSigned with keyId "${keyId}". Serve at your bootstrap URL (GET /api/bootstrap).`
);
