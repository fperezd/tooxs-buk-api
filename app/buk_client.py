"""
Cliente HTTP asíncrono para la API de BUK.
Gestiona autenticación, prefijos de ruta y timeouts.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urljoin

import httpx

from .config import Config, config as default_config


class BukClient:
    def __init__(self, cfg: Config | None = None) -> None:
        self._cfg = cfg or default_config

    def _build_url(self, path: str, skip_prefix: bool = False) -> str:
        if not path.startswith("/"):
            path = f"/{path}"
        prefix = "" if skip_prefix else self._cfg.route_prefix
        full_path = f"{prefix}{path}"
        return urljoin(self._cfg.base_url, full_path)

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            self._cfg.auth_header: self._cfg.auth_header_value,
        }
        if self._cfg.send_legacy_auth_header and self._cfg.legacy_auth_header:
            headers[self._cfg.legacy_auth_header] = self._cfg.api_token
        return headers

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        skip_prefix: bool = False,
    ) -> Any:
        url = self._build_url(path, skip_prefix=skip_prefix)
        clean_params = {k: str(v) for k, v in (params or {}).items() if v is not None and v != ""}

        async with httpx.AsyncClient(timeout=self._cfg.timeout_s) as client:
            response = await client.request(
                method,
                url,
                headers=self._headers(),
                params=clean_params or None,
                json=body,
            )

        if not response.is_success:
            try:
                detail = response.json()
            except Exception:
                detail = response.text
            raise RuntimeError(f"BUK respondió {response.status_code}: {detail}")

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return response.text

    async def get(self, path: str, params: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        return await self.request("GET", path, params=params, **kwargs)

    async def post(self, path: str, body: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        return await self.request("POST", path, body=body, **kwargs)

    async def ping_starter(self) -> Any:
        try:
            return await self.get(self._cfg.starter_health_path, skip_prefix=True)
        except Exception:
            return await self.get("/", skip_prefix=True)
