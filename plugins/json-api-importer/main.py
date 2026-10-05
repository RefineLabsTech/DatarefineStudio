"""Local JSON/API importer for DataRefine Studio.

The plugin deliberately supports GET only. Network access is explicit and
requires Trust in the Extensions panel. API credentials are supplied for one
operation, are not persisted by the plugin, and are never included in preview
output or error messages.
"""

import json
import socket
import urllib.error
import urllib.parse
import urllib.request

import polars as pl

MAX_RESPONSE_BYTES = 16 * 1024 * 1024
DEFAULT_TIMEOUT = 30


def _text(value):
    return "" if value is None else str(value)


def _number(value, fallback, low, high):
    try:
        number = int(str(value).strip())
    except Exception:
        number = fallback
    return max(low, min(high, number))


def _safe_url(value):
    """Require HTTPS, with loopback HTTP allowed for local API development."""
    raw = str(value or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ValueError("API URL must use HTTPS. HTTP is allowed only for localhost development.")
    if parsed.username or parsed.password:
        raise ValueError("Do not put API credentials in the URL.")
    host = parsed.hostname.casefold()
    if parsed.scheme == "http" and host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("HTTP API URLs are allowed only for localhost development; use HTTPS for remote APIs.")
    return raw


class _SafeRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        _safe_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


_OPENER = urllib.request.build_opener(_SafeRedirects())


def _headers(ctx):
    raw = str(ctx.get("headers_json") or "").strip()
    if not raw:
        parsed = {}
    else:
        try:
            parsed = json.loads(raw)
        except Exception as exc:
            raise ValueError("Headers must be valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Headers must be a JSON object, for example {\"Accept\":\"application/json\"}.")

    result = {
        "Accept": "application/json",
        "User-Agent": "DataRefineStudio JSON API Importer/1.0",
    }
    for key, value in parsed.items():
        name = str(key).strip()
        if not name or "\r" in name or "\n" in name:
            raise ValueError("Header names must be non-empty and must not contain line breaks.")
        text = str(value)
        if "\r" in text or "\n" in text:
            raise ValueError("Header values must not contain line breaks.")
        if len(text) > 8192:
            raise ValueError("Header values are limited to 8192 characters.")
        result[name] = text

    auth_type = str(ctx.get("auth_type") or "none").strip().lower()
    credential = str(ctx.get("credential") or "").strip()
    if auth_type in {"bearer", "api_key"} and not credential:
        raise ValueError("Enter the API credential or choose No authentication.")
    if auth_type == "bearer":
        result["Authorization"] = "Bearer " + credential
    elif auth_type == "api_key":
        header_name = str(ctx.get("api_key_header") or "X-API-Key").strip()
        if not header_name or "\r" in header_name or "\n" in header_name:
            raise ValueError("The API-key header name is invalid.")
        result[header_name] = credential
    elif auth_type != "none":
        raise ValueError("Choose No authentication, Bearer token, or API key.")
    return result


def _set_query(url, updates):
    parsed = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    for key, value in updates.items():
        if not key:
            continue
        pairs = [(old_key, old_value) for old_key, old_value in pairs if old_key != key]
        if value is not None and str(value) != "":
            pairs.append((key, str(value)))
    query = urllib.parse.urlencode(pairs)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def _read_response(response):
    length = response.headers.get("Content-Length")
    if length:
        try:
            if int(length) > MAX_RESPONSE_BYTES:
                raise ValueError("API response is larger than the 16 MB safety limit.")
        except ValueError as exc:
            if "safety limit" in str(exc):
                raise
    chunks = []
    total = 0
    while True:
        chunk = response.read(min(256 * 1024, MAX_RESPONSE_BYTES - total + 1))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise ValueError("API response is larger than the 16 MB safety limit.")
    try:
        text = b"".join(chunks).decode("utf-8-sig")
        return json.loads(text)
    except UnicodeDecodeError as exc:
        raise ValueError("API response is not UTF-8 JSON.") from exc
    except json.JSONDecodeError as exc:
        raise ValueError("API response is not valid JSON.") from exc


def _request_json(url, headers, timeout):
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return _read_response(response)
    except urllib.error.HTTPError as exc:
        raise ValueError("API request failed with HTTP {}.".format(exc.code)) from exc
    except socket.gaierror as exc:
        raise ValueError(
            "Unable to resolve the API hostname. Check that the API URL is correct, "
            "the domain exists, your internet connection is working, and the API server is online. "
            "Technical details: {}".format(exc)
        ) from exc
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        if "getaddrinfo failed" in reason.lower() or "name or service not known" in reason.lower() or "nodename nor servname" in reason.lower():
            raise ValueError(
                "Unable to resolve the API hostname. Check that the API URL is correct, "
                "the domain exists, your internet connection is working, and the API server is online. "
                "Technical details: {}".format(reason)
            ) from exc
        raise ValueError("API request failed: {}".format(reason)) from exc
    except TimeoutError as exc:
        raise ValueError(
            "The API request timed out. Check the API server and your network connection. "
            "Technical details: request timeout"
        ) from exc


def _path_get(value, path):
    current = value
    for part in str(path or "").strip().strip(".").split("."):
        if not part:
            continue
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return None
    return current


def _records(payload, path):
    if str(path or "").strip():
        target = _path_get(payload, path)
        if target is None:
            raise ValueError("Records path '{}' was not found in the JSON response.".format(path))
    else:
        target = payload
        if isinstance(payload, dict):
            for key in ("data", "items", "results", "records", "rows"):
                candidate = payload.get(key)
                if isinstance(candidate, list):
                    target = candidate
                    break

    if isinstance(target, list):
        return target
    if isinstance(target, dict):
        return [target]
    if target is None:
        return []
    return [{"value": target}]


def _next_url(payload, path, current_url):
    target = _path_get(payload, path or "next")
    if isinstance(target, dict):
        target = target.get("href") or target.get("url") or target.get("next")
    if not target:
        return ""
    return urllib.parse.urljoin(current_url, str(target))


def _fetch_records(ctx):
    url = _safe_url(ctx.get("url"))
    headers = _headers(ctx)
    timeout = _number(ctx.get("timeout"), DEFAULT_TIMEOUT, 5, 120)
    records_path = str(ctx.get("records_path") or "").strip()
    pagination = str(ctx.get("pagination") or "none").strip().lower()
    max_pages = _number(ctx.get("max_pages"), 10, 1, 100)
    page_size = _number(ctx.get("page_size"), 100, 1, 10000)
    all_records = []
    pages = 0
    current_url = url
    page_number = _number(ctx.get("start_page"), 1, 0, 1_000_000)
    offset = _number(ctx.get("start_offset"), 0, 0, 1_000_000_000)

    while pages < max_pages:
        if pagination == "page":
            current_url = _set_query(
                url,
                {
                    str(ctx.get("page_param") or "page").strip(): page_number,
                    str(ctx.get("page_size_param") or "limit").strip(): page_size,
                },
            )
        elif pagination == "offset":
            current_url = _set_query(
                url,
                {
                    str(ctx.get("offset_param") or "offset").strip(): offset,
                    str(ctx.get("limit_param") or "limit").strip(): page_size,
                },
            )
        else:
            _safe_url(current_url)

        payload = _request_json(current_url, headers, timeout)
        page_records = _records(payload, records_path)
        all_records.extend(page_records)
        pages += 1

        if pagination == "none":
            break
        if pagination == "page":
            if len(page_records) < page_size:
                break
            page_number += 1
            continue
        if pagination == "offset":
            if len(page_records) < page_size:
                break
            offset += page_size
            continue
        if pagination == "next_link":
            next_url = _next_url(payload, str(ctx.get("next_link_path") or "next").strip(), current_url)
            if not next_url or next_url == current_url:
                break
            current_url = _safe_url(next_url)
            continue
        raise ValueError("Choose a supported pagination mode.")

    return all_records, pages


def _json_value(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _array_value(values, mode):
    if mode == "first":
        if not values:
            return None
        value = values[0]
        return value if value is None or isinstance(value, (str, int, float, bool)) else _json_value(value)
    if mode == "json":
        return _json_value(values)
    simple = []
    for value in values:
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            simple.append(str(value))
        else:
            simple.append(_json_value(value))
    return ", ".join(simple)


def _flatten(value, prefix, output, delimiter, array_mode, depth=0):
    if isinstance(value, dict):
        if not value:
            output[prefix or "value"] = "{}"
            return
        if depth >= 8:
            output[prefix or "value"] = _json_value(value)
            return
        for key, child in value.items():
            name = str(key)
            child_prefix = name if not prefix else prefix + delimiter + name
            _flatten(child, child_prefix, output, delimiter, array_mode, depth + 1)
        return
    if isinstance(value, list):
        output[prefix or "value"] = _array_value(value, array_mode)
        return
    output[prefix or "value"] = value


def _flatten_records(records, ctx):
    delimiter = str(ctx.get("delimiter") or ".")
    if delimiter not in {".", "_", "__"}:
        delimiter = "."
    array_mode = str(ctx.get("array_mode") or "join").lower()
    if array_mode not in {"join", "json", "first"}:
        array_mode = "join"
    flattened = []
    for record in records:
        row = {}
        if isinstance(record, dict):
            _flatten(record, "", row, delimiter, array_mode)
        else:
            _flatten({"value": record}, "", row, delimiter, array_mode)
        flattened.append(row)
    return flattened


def _frame(rows):
    if not rows:
        raise ValueError("The API returned no records to import.")
    return pl.from_dicts(rows, infer_schema_length=None, strict=False)


def preview(df, ctx):
    records, pages = _fetch_records(ctx)
    rows = _flatten_records(records, ctx)
    if not rows:
        return "The API returned no records to preview."
    columns = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    sample = json.dumps(rows[:5], ensure_ascii=False, default=str, indent=2)
    if len(sample) > 5000:
        sample = sample[:5000] + "\n…"
    return (
        "JSON/API Importer — preview\n"
        "Fetched {} records across {} page(s).\n"
        "Flattened columns ({}): {}\n\n"
        "Sample:\n{}\n\n"
        "Preview is read-only. API credentials are not included in this report."
    ).format(len(rows), pages, len(columns), ", ".join(columns[:80]), sample)


def import_data(df, ctx):
    records, _pages = _fetch_records(ctx)
    return _frame(_flatten_records(records, ctx))
