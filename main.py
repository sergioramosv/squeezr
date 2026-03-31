import json
import os
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

from compressor import compress_messages, compress_openai_messages, get_cache
from config import Config
from stats import Stats, print_banner
from system_prompt import maybe_compress_system_prompt

config = Config()
stats = Stats()

ANTHROPIC_API = "https://api.anthropic.com"
OPENAI_API = "https://api.openai.com"

SKIP_HEADERS = {"host", "content-length", "transfer-encoding", "connection"}
SKIP_RESPONSE_HEADERS = {"content-encoding", "transfer-encoding", "connection"}


def forward_headers(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in SKIP_HEADERS}


def estimate_chars(messages: list) -> int:
    return len(json.dumps(messages))


def extract_openai_key(headers: dict) -> str:
    auth = headers.get("authorization", headers.get("Authorization", ""))
    return auth.removeprefix("Bearer ").removeprefix("bearer ").strip()


def detect_upstream(headers: dict) -> str:
    """Returns the upstream API URL based on request headers."""
    lower_keys = {k.lower() for k in headers}
    if "authorization" in lower_keys and "x-api-key" not in lower_keys:
        return OPENAI_API
    return ANTHROPIC_API


@asynccontextmanager
async def lifespan(app: FastAPI):
    print_banner(config.port)
    yield


app = FastAPI(lifespan=lifespan)


# ── Anthropic / Claude Code ───────────────────────────────────────────────────

@app.post("/v1/messages")
async def proxy_messages(request: Request):
    body = await request.json()
    headers = dict(request.headers)
    api_key = headers.get("x-api-key", os.environ.get("ANTHROPIC_API_KEY", ""))

    if config.compress_system_prompt and not config.dry_run:
        body["system"] = await maybe_compress_system_prompt(body.get("system"), api_key)

    messages = body.get("messages", [])
    original_chars = estimate_chars(messages)

    compressed_messages, savings = await compress_messages(messages, api_key, config)
    body["messages"] = compressed_messages

    stats.record(original_chars, estimate_chars(compressed_messages), savings)

    fwd_headers = forward_headers(headers)

    if body.get("stream", False):
        return StreamingResponse(
            _stream(f"{ANTHROPIC_API}/v1/messages", body, fwd_headers),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
        )

    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(f"{ANTHROPIC_API}/v1/messages", json=body, headers=fwd_headers)
        resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in SKIP_RESPONSE_HEADERS}
        return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)


# ── OpenAI / Codex ────────────────────────────────────────────────────────────

@app.post("/v1/chat/completions")
async def proxy_chat_completions(request: Request):
    body = await request.json()
    headers = dict(request.headers)
    openai_key = extract_openai_key(headers)

    messages = body.get("messages", [])

    # Compress system message (first message if role == "system") with GPT-4o-mini
    if config.compress_system_prompt and not config.dry_run and messages and messages[0].get("role") == "system":
        sys_content = messages[0].get("content", "")
        if isinstance(sys_content, str):
            compressed_sys = await maybe_compress_system_prompt(sys_content, openai_key, use_openai=True)
            if compressed_sys != sys_content:
                import copy
                messages = copy.deepcopy(messages)
                messages[0]["content"] = compressed_sys
                body["messages"] = messages

    original_chars = estimate_chars(messages)
    compressed_messages, savings = await compress_openai_messages(messages, openai_key, config)
    body["messages"] = compressed_messages

    stats.record(original_chars, estimate_chars(compressed_messages), savings)

    fwd_headers = forward_headers(headers)

    if body.get("stream", False):
        return StreamingResponse(
            _stream(f"{OPENAI_API}/v1/chat/completions", body, fwd_headers),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
        )

    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(f"{OPENAI_API}/v1/chat/completions", json=body, headers=fwd_headers)
        resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in SKIP_RESPONSE_HEADERS}
        return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)


# ── Shared stream helper ──────────────────────────────────────────────────────

async def _stream(url: str, body: dict, headers: dict):
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            async for chunk in resp.aiter_bytes():
                yield chunk


# ── Catch-all: forward to correct upstream ────────────────────────────────────

@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def catch_all(request: Request, path: str):
    body = await request.body()
    headers = dict(request.headers)
    upstream = detect_upstream(headers)
    fwd_headers = forward_headers(headers)

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.request(
            method=request.method,
            url=f"{upstream}/{path}",
            content=body,
            headers=fwd_headers,
            params=dict(request.query_params),
        )
        resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in SKIP_RESPONSE_HEADERS}
        return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)


# ── Internal endpoints ────────────────────────────────────────────────────────

@app.get("/squeezr/stats")
async def get_stats():
    s = stats.summary()
    s["cache"] = get_cache(config).stats()
    s["dry_run"] = config.dry_run
    return s


@app.get("/squeezr/health")
async def health():
    return {"status": "ok", "version": "0.4.0"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=config.port, log_level="warning")
