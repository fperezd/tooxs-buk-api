"""
Configuración de la aplicación.
Lee variables de entorno con valores por defecto seguros.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Falta la variable de entorno obligatoria: {name}")
    return value


def _optional(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _int_with_default(name: str, fallback: int) -> int:
    raw = os.getenv(name, "")
    if not raw:
        return fallback
    try:
        value = int(raw)
        if value <= 0:
            raise ValueError
        return value
    except ValueError:
        raise RuntimeError(f"La variable {name} debe ser un entero positivo.")


def _normalize_prefix(prefix: str) -> str:
    if not prefix:
        return ""
    p = prefix if prefix.startswith("/") else f"/{prefix}"
    return p.rstrip("/")


@dataclass(frozen=True)
class Config:
    mode: str
    base_url: str
    api_token: str
    auth_header: str
    auth_scheme: str
    legacy_auth_header: str
    send_legacy_auth_header: bool
    route_prefix: str
    timeout_ms: int
    starter_health_path: str
    server_api_key: str

    @property
    def auth_header_value(self) -> str:
        if self.auth_scheme:
            return f"{self.auth_scheme} {self.api_token}"
        return self.api_token

    @property
    def timeout_s(self) -> float:
        return self.timeout_ms / 1000


def _load() -> Config:
    starter_base = _optional("BUK_STARTER_BASE_URL")
    direct_base = _optional("BUK_BASE_URL")
    base_url = (starter_base or direct_base).rstrip("/")

    if not base_url:
        raise RuntimeError("Falta BUK_STARTER_BASE_URL o BUK_BASE_URL en el entorno.")

    starter_token = _optional("BUK_STARTER_API_TOKEN")
    direct_token = _optional("BUK_API_TOKEN")
    api_token = starter_token or direct_token

    if not api_token:
        raise RuntimeError("Falta BUK_STARTER_API_TOKEN o BUK_API_TOKEN en el entorno.")

    send_legacy = _optional("BUK_STARTER_SEND_LEGACY_AUTH_HEADER", "true").lower() != "false"

    return Config(
        mode="starter" if starter_base else "direct",
        base_url=base_url,
        api_token=api_token,
        auth_header=_optional("BUK_STARTER_AUTH_HEADER") or _optional("BUK_AUTH_HEADER") or "Authorization",
        auth_scheme=_optional("BUK_STARTER_AUTH_SCHEME") or _optional("BUK_AUTH_SCHEME") or "Bearer",
        legacy_auth_header=_optional("BUK_STARTER_LEGACY_AUTH_HEADER") or "auth_token",
        send_legacy_auth_header=send_legacy,
        route_prefix=_normalize_prefix(_optional("BUK_STARTER_ROUTE_PREFIX")),
        timeout_ms=_int_with_default("BUK_TIMEOUT_MS", 15000),
        starter_health_path=_optional("BUK_STARTER_HEALTH_PATH") or "/health",
        server_api_key=_optional("SERVER_API_KEY"),
    )


config = _load()
