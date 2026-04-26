"""
API HTTP con FastAPI.
Expone /health y /chat (igual que la versión Node).
"""
from __future__ import annotations

import asyncio
import logging
import os

import httpx
from fastapi import Depends, FastAPI, HTTPException, Security, status
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel

from .agent import BukConversationalAgent
from .config import config

logger = logging.getLogger(__name__)

app = FastAPI(title="Tooxs BUK API", version="1.0.0", docs_url=None, redoc_url=None)

_agent = BukConversationalAgent()

# ── Autenticación ─────────────────────────────────────────────────────────────

_api_key_header = APIKeyHeader(name="X-Api-Key", auto_error=False)


async def require_api_key(key: str | None = Security(_api_key_header)) -> None:
    server_key = config.server_api_key
    if not server_key:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Servidor no configurado correctamente.")
    if key != server_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autorizado.")


# ── Schemas ───────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    response: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"status": "Ok!", "mode": config.mode}


@app.post("/chat", response_model=ChatResponse, dependencies=[Depends(require_api_key)])
async def chat(req: ChatRequest) -> ChatResponse:
    if not req.message.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El campo 'message' es requerido.")
    try:
        result = await _agent.handle_input(req.message)
        if result == "__exit__":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Comando no permitido en modo API.")
        return ChatResponse(response=result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error al procesar mensaje")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Error interno al procesar la solicitud.") from exc


@app.get("/query", response_model=ChatResponse, dependencies=[Depends(require_api_key)])
async def query(message: str) -> ChatResponse:
    if not message.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El parámetro 'message' es requerido.")
    try:
        result = await _agent.handle_input(message)
        if result == "__exit__":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Comando no permitido en modo API.")
        return ChatResponse(response=result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error al procesar query")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Error interno al procesar la solicitud.") from exc


# ── Keep-alive (evita que Render duerma el servicio en plan free) ─────────────

@app.on_event("startup")
async def start_keep_alive() -> None:
    self_url = os.getenv("SELF_URL", "")
    if not self_url:
        return

    async def _ping() -> None:
        while True:
            await asyncio.sleep(10 * 60)
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.get(f"{self_url}/health")
                logger.info("[keep-alive] ping ok")
            except Exception as exc:
                logger.warning("[keep-alive] ping falló: %s", exc)

    asyncio.create_task(_ping())
