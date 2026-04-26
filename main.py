"""Entrypoint para Render (uvicorn app.server:app)."""
from app.server import app  # noqa: F401 — re-export para uvicorn

__all__ = ["app"]
