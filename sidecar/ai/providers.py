"""Pluggable AI providers — Ollama, OpenAI, Gemini, Anthropic, OpenRouter."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx


class AIError(RuntimeError):
    pass


DEFAULT_PROMPTS = {
    "structural": (
        "You are DataRefine Studio's deterministic-first cleaning assistant.\n"
        "Step: structural repair — headers, types, schema mapping.\n"
        "Only propose safe, reversible cell/column fixes. Do not invent rows.\n"
        "Columns: {columns}\n"
        "Sample rows: {sample}\n"
        "Extra instructions: {extra}\n"
        "Return ONLY a JSON array:\n"
        '[{ "column": "", "original": "", "suggested": "", "confidence": 0.0, "reason": "", "rule": "" }]\n'
        "Prefer regex/SQL/Polars rules over one-off edits. confidence is 0..1."
    ),
    "semantic": (
        "You are DataRefine Studio's deterministic-first cleaning assistant.\n"
        "Step: semantic cleaning — missing values, categories, entity resolution.\n"
        "Columns: {columns}\n"
        "Sample rows: {sample}\n"
        "Extra instructions: {extra}\n"
        "Return ONLY a JSON array:\n"
        '[{ "column": "", "original": "", "suggested": "", "confidence": 0.0, "reason": "", "rule": "" }]\n'
        "Do not invent rows. Prefer reusable rules. confidence is 0..1."
    ),
    "validation": (
        "You are DataRefine Studio's deterministic-first cleaning assistant.\n"
        "Step: validation — business rules, compliance, outliers.\n"
        "Columns: {columns}\n"
        "Sample rows: {sample}\n"
        "Extra instructions: {extra}\n"
        "Return ONLY a JSON array:\n"
        '[{ "column": "", "original": "", "suggested": "", "confidence": 0.0, "reason": "", "rule": "" }]\n'
        "Flag issues as suggested replacements when a clear fix exists. confidence is 0..1."
    ),
}


def complete(settings: dict[str, Any], prompt: str) -> str:
    provider = (settings.get("provider") or "ollama").lower()
    model = settings.get("model") or "llama3.1"
    temperature = float(settings.get("temperature") or 0.2)
    max_tokens = int(settings.get("max_tokens") or 1024)
    timeout = float(settings.get("timeout") or 60)
    if provider == "ollama":
        base = settings.get("base_url") or "http://127.0.0.1:11434"
        r = httpx.post(
            f"{base.rstrip('/')}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False, "options": {"temperature": temperature}},
            timeout=timeout,
        )
        r.raise_for_status()
        return r.json().get("response") or ""
    if provider in {"openai", "openrouter"}:
        base = settings.get("base_url") or (
            "https://openrouter.ai/api/v1" if provider == "openrouter" else "https://api.openai.com/v1"
        )
        headers = {"Authorization": f"Bearer {settings.get('api_key') or ''}"}
        r = httpx.post(
            f"{base.rstrip('/')}/chat/completions",
            headers=headers,
            json={
                "model": model,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=timeout,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]
    if provider == "anthropic":
        r = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.get("api_key") or "",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=timeout,
        )
        r.raise_for_status()
        blocks = r.json().get("content") or []
        return "".join(b.get("text", "") for b in blocks)
    if provider == "gemini":
        key = settings.get("api_key") or ""
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        r = httpx.post(
            url,
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=timeout,
        )
        r.raise_for_status()
        cands = r.json().get("candidates") or []
        if not cands:
            return ""
        parts = cands[0].get("content", {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts)
    raise AIError(f"Unknown provider: {provider}")


def cleaning_prompt(
    step: str,
    columns: list[str],
    sample: list,
    extra: str = "",
    template: str | None = None,
) -> str:
    tpl = (template or "").strip() or DEFAULT_PROMPTS.get(step) or DEFAULT_PROMPTS["structural"]
    values = {
        "step": step,
        "columns": ", ".join(str(c) for c in columns),
        "sample": sample[:12],
        "extra": extra.strip() or "(none)",
    }
    try:
        return tpl.format(**values)
    except (KeyError, IndexError, ValueError):
        return (
            f"{tpl}\n\nStep: {step}\nColumns: {values['columns']}\n"
            f"Sample rows: {values['sample']}\nExtra: {values['extra']}"
        )


def parse_proposals(text: str) -> list[dict[str, Any]]:
    if not text:
        return []
    blob = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", blob, re.I)
    if fence:
        blob = fence.group(1).strip()
    start, end = blob.find("["), blob.rfind("]")
    if start < 0 or end <= start:
        return []
    try:
        data = json.loads(blob[start : end + 1])
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        col = str(item.get("column") or item.get("col") or "").strip()
        if not col:
            continue
        conf = item.get("confidence")
        try:
            conf_f = float(conf) if conf is not None else 0.8
        except (TypeError, ValueError):
            conf_f = 0.8
        if conf_f > 1:
            conf_f = conf_f / 100.0
        out.append(
            {
                "column": col,
                "original": item.get("original"),
                "suggested": item.get("suggested"),
                "confidence": round(conf_f, 4),
                "reason": str(item.get("reason") or ""),
                "rule": str(item.get("rule") or ""),
                "row": item.get("row"),
            }
        )
    return out
