"""
Agente conversacional BUK.
Traduce lenguaje natural a llamadas a la API de BUK y retorna respuestas compactas.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import date, datetime
from typing import Any

from .buk_client import BukClient

# ── Constantes ───────────────────────────────────────────────────────────────

MONTH_TO_NUMBER: dict[str, str] = {
    "enero": "01", "febrero": "02", "marzo": "03", "abril": "04",
    "mayo": "05", "junio": "06", "julio": "07", "agosto": "08",
    "septiembre": "09", "setiembre": "09", "octubre": "10",
    "noviembre": "11", "diciembre": "12",
}

PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DIRECT_PERIOD_RE = re.compile(r"\b\d{4}-(0[1-9]|1[0-2])\b")
YEAR_RE = re.compile(r"\b(20\d{2})\b")
DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ISO_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([Zz]|[+-]\d{2}:?\d{2})?$"
)
MONEY_KEY_RE = re.compile(
    r"(wage|salary|sueldo|monto|amount|price|precio|cost|costo|total|payment|pago|liquid|remuneracion|haber)",
    re.IGNORECASE,
)
LIQUIDO_RE = re.compile(r"l[ií]quido a recibir", re.IGNORECASE)

PROTECTED_RULES = [{"tokens": ["fernando", "perez"]}]
REDACTED = "restringido"
CONTRACTUAL_FIELDS = {
    "contract_type", "notice_date", "contract_finishing_date_1",
    "contract_finishing_date_2", "weekly_hours", "working_schedule_type",
    "periodicity", "frequency", "contract_subscription_date", "without_wage",
    "other_type_of_working_day", "base_wage", "contractual_stipulation",
    "contractual_detail", "reward", "reward_concept", "reward_payment_period",
    "reward_description",
}

# ── Formateo ──────────────────────────────────────────────────────────────────

def _format_clp(value: float | int) -> str:
    from babel.numbers import format_currency
    try:
        return format_currency(value, "CLP", locale="es_CL", format_type="standard")
    except Exception:
        # Fallback manual si babel no está disponible
        return f"${value:,.0f}".replace(",", ".")


def _format_uf(value: float) -> str:
    return f"{value:,.4f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _format_number(value: float | int) -> str:
    return f"{value:,.0f}".replace(",", ".")


def _should_format_as_money(key: str) -> bool:
    if not key:
        return False
    k = key.lower()
    if k in ("total",) or any(s in k for s in ("total_empleados", "cantidad", "count", "numero")):
        return False
    return bool(MONEY_KEY_RE.search(k))


def _format_date(raw: str) -> str:
    if DATE_ONLY_RE.match(raw):
        y, m, d = raw.split("-")
        return f"{d}/{m}/{y}"
    if ISO_DATETIME_RE.match(raw):
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return dt.strftime("%d/%m/%Y %H:%M:%S")
        except Exception:
            pass
    return raw


def _format_for_display(value: Any, key: str = "") -> Any:
    if isinstance(value, list):
        return [_format_for_display(v, key) for v in value]
    if isinstance(value, dict):
        return {k: _format_for_display(v, k) for k, v in value.items()}
    if isinstance(value, str):
        return _format_date(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if _should_format_as_money(key):
            return _format_clp(int(value))
        return _format_number(value)
    return value


def _compact_json(obj: Any) -> str:
    return json.dumps(_format_for_display(obj), ensure_ascii=False)


# ── Normalización de texto ────────────────────────────────────────────────────

def _normalize(text: str) -> str:
    return text.strip().lower()


def _normalize_for_search(value: Any) -> str:
    text = str(value or "")
    nfkd = unicodedata.normalize("NFD", text)
    without_accents = "".join(c for c in nfkd if unicodedata.category(c) != "Mn")
    return without_accents.lower().strip()


# ── Empleados ─────────────────────────────────────────────────────────────────

def _extract_employees(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    return []


def _get_display_name(emp: dict) -> str:
    return (
        emp.get("full_name")
        or emp.get("name")
        or " ".join(filter(None, [emp.get("first_name"), emp.get("surname"), emp.get("second_surname")]))
    )


def _is_protected(emp: dict) -> bool:
    name = _normalize_for_search(_get_display_name(emp))
    return any(all(t in name for t in rule["tokens"]) for rule in PROTECTED_RULES)


def _redact_job(job: dict) -> dict:
    return {k: (REDACTED if k in CONTRACTUAL_FIELDS else v) for k, v in job.items()}


def _apply_protection(emp: dict) -> dict:
    if not _is_protected(emp):
        return emp
    emp = dict(emp)
    if "current_job" in emp and isinstance(emp["current_job"], dict):
        emp["current_job"] = _redact_job(emp["current_job"])
    if "jobs" in emp and isinstance(emp["jobs"], list):
        emp["jobs"] = [_redact_job(j) for j in emp["jobs"]]
    return emp


def _employee_matches(emp: dict, query: str) -> bool:
    haystack = " ".join(
        _normalize_for_search(v)
        for v in [
            emp.get("full_name"), emp.get("name"), emp.get("first_name"),
            emp.get("surname"), emp.get("second_surname"),
            emp.get("email"), emp.get("rut"), emp.get("document_number"),
        ]
    )
    return query in haystack


def _build_employee_summary(emp: dict) -> dict:
    safe = _apply_protection(emp)
    job = safe.get("current_job") or {}
    return {
        "id": safe.get("id"),
        "nombre": _get_display_name(safe),
        "cargo": job.get("role", {}).get("name") if isinstance(job.get("role"), dict) else None,
        "sueldo_base": job.get("base_wage"),
        "estado": safe.get("status"),
    }


def _get_payroll_amount(emp: dict) -> float:
    job = emp.get("current_job") or {}
    candidates = [
        job.get("total_haberes"), job.get("total_assets"),
        emp.get("total_haberes"), emp.get("total_assets"),
        job.get("base_wage"),
    ]
    for v in candidates:
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return 0.0


def _build_rut_to_name(employees: list[dict]) -> dict[str, str]:
    result = {}
    for emp in employees:
        rut = emp.get("rut") or emp.get("document_number")
        if rut:
            result[rut] = _get_display_name(emp) or rut
    return result


# ── UF ────────────────────────────────────────────────────────────────────────

_uf_cache: dict = {"value": None, "date": None, "display": None}


async def _fetch_uf() -> dict:
    import httpx
    today = date.today().isoformat()
    if _uf_cache["date"] == today and _uf_cache["value"] is not None:
        return _uf_cache

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get("https://mindicador.cl/api/uf")
        resp.raise_for_status()
        data = resp.json()

    valor = data.get("serie", [{}])[0].get("valor")
    fecha_raw = data.get("serie", [{}])[0].get("fecha", "")

    if not isinstance(valor, (int, float)):
        raise RuntimeError("Respuesta inesperada desde mindicador.cl")

    fecha_display = fecha_raw[:10].replace("-", "/") if fecha_raw else today
    y, m, d = fecha_display.split("/")
    fecha_display = f"{d}/{m}/{y}"

    _uf_cache.update({"value": valor, "date": today, "display": fecha_display})
    return _uf_cache


def _clp_to_uf(clp: float, uf: float) -> float:
    return clp / uf


# ── Contabilidad ──────────────────────────────────────────────────────────────

def _summarize_accounting(payload: Any) -> dict:
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    debit = credit = other = lines = 0
    for row in rows:
        for item in row.get("items", []):
            amount = item.get("amount")
            if not isinstance(amount, (int, float)):
                try:
                    amount = float(amount)
                except Exception:
                    continue
            lines += 1
            entry = item.get("entry_type")
            if entry == "debit":
                debit += amount
            elif entry == "credit":
                credit += amount
            else:
                other += amount
    return {
        "employees_count": len(rows),
        "line_items": lines,
        "total_debit_clp": debit,
        "total_credit_clp": credit,
        "total_other_clp": other,
    }


def _summarize_by_employee(payload: Any, rut_to_name: dict[str, str] | None = None) -> list[dict]:
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    by_rut: dict[str, dict] = {}
    for row in rows:
        for item in row.get("items", []):
            rut = item.get("employee_rut") or item.get("employee_document_number") or "desconocido"
            amount = item.get("amount")
            if not isinstance(amount, (int, float)):
                try:
                    amount = float(amount)
                except Exception:
                    continue
            entry = by_rut.setdefault(rut, {"rut": rut, "haberes": 0.0, "liquido": None})
            if item.get("entry_type") == "debit":
                entry["haberes"] += amount
            if LIQUIDO_RE.search(item.get("description") or ""):
                entry["liquido"] = amount

    rut_to_name = rut_to_name or {}
    return [
        {
            "rut": e["rut"],
            "nombre": rut_to_name.get(e["rut"]),
            "total_haberes_clp": e["haberes"],
            "liquido_clp": e["liquido"],
        }
        for e in by_rut.values()
    ]


# ── Períodos ──────────────────────────────────────────────────────────────────

def _extract_periods(lower: str) -> list[str]:
    direct = list(dict.fromkeys(DIRECT_PERIOD_RE.findall(lower)))
    if direct:
        return [p for p in direct if PERIOD_RE.match(p)]
    year_match = YEAR_RE.search(lower)
    if not year_match:
        return []
    year = year_match.group(1)
    found = []
    for month_name, month_num in MONTH_TO_NUMBER.items():
        if month_name in lower:
            period = f"{year}-{month_num}"
            if period not in found:
                found.append(period)
    return found


def _split_period(period: str) -> dict | None:
    if not PERIOD_RE.match(period):
        return None
    year, month = period.split("-")
    return {"period": period, "year": int(year), "month": int(month)}


def _extract_year(lower: str) -> int:
    m = YEAR_RE.search(lower)
    return int(m.group(1)) if m else date.today().year


# ── Analytics ─────────────────────────────────────────────────────────────────

def _build_evolucion(records: list[dict], alert_threshold: float = 5.0) -> tuple[list[dict], list[str]]:
    sorted_records = sorted(records, key=lambda r: r["period"])
    result = []
    alerts = []
    for i, item in enumerate(sorted_records):
        prev = sorted_records[i - 1] if i > 0 else None
        var_pct = None
        if prev and prev["total_clp"] > 0:
            var_pct = round((item["total_clp"] - prev["total_clp"]) / prev["total_clp"] * 100, 1)
        entry: dict = {
            "periodo": item["period"],
            "total_clp": item["total_clp"],
            "headcount": item["employees_count"],
            "variacion_pct": var_pct,
        }
        if var_pct is not None and abs(var_pct) >= alert_threshold:
            sign = "+" if var_pct > 0 else ""
            entry["alerta"] = f"{sign}{var_pct}% vs mes anterior"
            alerts.append(f"{item['period']}: {entry['alerta']}")
        result.append(entry)
    return result, alerts


def _build_proyeccion(records: list[dict]) -> dict | None:
    if not records:
        return None
    sorted_records = sorted(records, key=lambda r: r["period"])
    total = sum(r["total_clp"] for r in sorted_records)
    promedio = total / len(sorted_records)
    return {
        "meses_base": len(sorted_records),
        "periodo_desde": sorted_records[0]["period"],
        "periodo_hasta": sorted_records[-1]["period"],
        "total_real_clp": round(total),
        "promedio_mensual_clp": round(promedio),
        "proyeccion_anual_clp": round(promedio * 12),
        "nota": f"Basado en {len(sorted_records)} mes{'es' if len(sorted_records) != 1 else ''} reales",
    }


# ── Agente principal ──────────────────────────────────────────────────────────

class BukConversationalAgent:
    def __init__(self, client: BukClient | None = None) -> None:
        self._client = client or BukClient()

    async def _find_employee_by_name(self, query: str) -> dict | None:
        normalized = _normalize_for_search(query)
        result = await self._client.get("/api/v1/employees", params={"search": query})
        employees = _extract_employees(result)
        matched = [e for e in employees if _employee_matches(e, normalized)]
        if not matched:
            return None
        full = await self._client.get(f"/api/v1/employees/{matched[0]['id']}")
        return full.get("data", full) if isinstance(full, dict) else full

    async def _fetch_periods_for_year(self, year: int) -> list[dict]:
        today = date.today()
        max_month = today.month if year == today.year else 12
        results = []
        for month in range(1, max_month + 1):
            period = f"{year}-{month:02d}"
            try:
                payload = await self._client.get(
                    "/api/v1/accounting",
                    params={"month": month, "year": year, "process": "payroll"},
                )
                summary = _summarize_accounting(payload)
                if summary["employees_count"] > 0:
                    results.append({
                        "period": period,
                        "total_clp": summary["total_debit_clp"],
                        "employees_count": summary["employees_count"],
                        "payload": payload,
                    })
            except Exception:
                pass
        return results

    async def handle_input(self, raw_input: str) -> str:
        text = raw_input.strip()
        lower = _normalize(text)

        if not text:
            return "Escribe un comando. Usa 'ayuda' para ver ejemplos."

        if lower in ("ayuda", "help", "?"):
            return self._help()

        if lower in ("salir", "exit", "quit"):
            return "__exit__"

        if lower == "ping starter":
            result = await self._client.ping_starter()
            return f"Starter OK:\n{_compact_json(result)}"

        if lower == "ping":
            result = await self._client.get("/")
            return f"Ping OK:\n{_compact_json(result)}"

        wants_uf = lower.endswith(" en uf") or lower.endswith(" en ufs") or " en uf " in lower

        # ── UF ──────────────────────────────────────────────────────────────
        if lower in ("uf", "valor uf", "uf hoy", "uf del dia", "uf del día"):
            uf = await _fetch_uf()
            return f"UF del {uf['display']}: {_format_clp(uf['value'])}"

        # ── Empleados ────────────────────────────────────────────────────────
        if lower in ("empleados", "empleados activos"):
            result = await self._client.get("/api/v1/employees", params={"status": "activo"})
            employees = _extract_employees(result)
            return _compact_json({"total": len(employees), "estado": "activo", "empleados": [_build_employee_summary(e) for e in employees]})

        if lower == "empleados inactivos":
            result = await self._client.get("/api/v1/employees", params={"status": "inactivo"})
            employees = _extract_employees(result)
            return _compact_json({"total": len(employees), "estado": "inactivo", "empleados": [_build_employee_summary(e) for e in employees]})

        if lower in ("empleados todos", "todos los empleados"):
            result = await self._client.get("/api/v1/employees")
            employees = _extract_employees(result)
            return _compact_json({"total": len(employees), "empleados": [_build_employee_summary(e) for e in employees]})

        if lower.startswith("buscar empleado "):
            suffix = text[len("buscar empleado "):].strip()
            query = re.sub(r"\s+en\s+ufs?$", "", suffix, flags=re.IGNORECASE).strip()
            normalized = _normalize_for_search(query)
            result = await self._client.get("/api/v1/employees", params={"search": query})
            employees = _extract_employees(result)
            matched = [e for e in employees if _employee_matches(e, normalized)]
            if not matched:
                return f"No encontré empleados para: {query}"
            summaries = [_build_employee_summary(e) for e in matched]
            if wants_uf:
                uf = await _fetch_uf()
                for s in summaries:
                    wage = s.get("sueldo_base")
                    if isinstance(wage, (int, float)):
                        s["sueldo_base_uf"] = f"UF {_format_uf(_clp_to_uf(wage, uf['value']))}"
                return _compact_json({"query": query, "total": len(summaries), "valor_uf": uf["value"], "fecha_uf": uf["display"], "data": summaries})
            return _compact_json({"query": query, "total": len(summaries), "data": summaries})

        if lower.startswith("empleado "):
            raw_suffix = text[len("empleado "):].strip()
            emp_id = re.sub(r"\s+en\s+ufs?$", "", raw_suffix, flags=re.IGNORECASE).strip()
            result = await self._client.get(f"/api/v1/employees/{emp_id}")
            employee = result.get("data", result) if isinstance(result, dict) else result
            safe = _apply_protection(employee)
            job = safe.get("current_job") or {}
            compact = {
                "id": safe.get("id"),
                "nombre": _get_display_name(safe),
                "rut": safe.get("rut"),
                "cargo": job.get("role", {}).get("name") if isinstance(job.get("role"), dict) else None,
                "sueldo_base": job.get("base_wage"),
                "estado": safe.get("status"),
                "email": safe.get("email"),
                "afp": safe.get("pension_fund"),
                "salud": safe.get("health_company"),
                "fecha_ingreso": safe.get("active_since"),
            }
            if wants_uf:
                uf = await _fetch_uf()
                wage = _get_payroll_amount(safe)
                compact["sueldo_base_uf"] = f"UF {_format_uf(_clp_to_uf(wage, uf['value']))}"
                compact["valor_uf_usado"] = uf["value"]
                compact["fecha_uf"] = uf["display"]
            return _compact_json(compact)

        # ── Líquido de <nombre> <periodo> ────────────────────────────────────
        liquido_prefixes = [
            "sueldo liquido de ", "monto liquido de ", "liquido de ",
            "sueldo líquido de ", "monto líquido de ", "líquido de ",
        ]
        liquido_prefix = next((p for p in liquido_prefixes if lower.startswith(p)), None)
        if liquido_prefix:
            suffix = text[len(liquido_prefix):].strip()
            periods = _extract_periods(suffix.lower())
            if not periods:
                return "Indica el período. Ejemplo: liquido de Juan Pérez marzo 2026"
            parsed = _split_period(periods[0])
            if not parsed:
                return f"No pude interpretar el período: {periods[0]}"
            # Aislar nombre removiendo tokens de periodo
            name_raw = suffix
            name_raw = DIRECT_PERIOD_RE.sub("", name_raw)
            months_pattern = "|".join(MONTH_TO_NUMBER.keys())
            name_raw = re.sub(rf"\b({months_pattern})\b", "", name_raw, flags=re.IGNORECASE)
            name_raw = YEAR_RE.sub("", name_raw)
            name_raw = re.sub(r"\ben\b", "", name_raw, flags=re.IGNORECASE)
            name_raw = re.sub(r"\s{2,}", " ", name_raw).strip()
            if not name_raw:
                return "No pude identificar el nombre del empleado."
            employee = await self._find_employee_by_name(name_raw)
            if not employee:
                return f"No encontré empleados para: {name_raw}"
            safe = _apply_protection(employee)
            rut = safe.get("rut") or safe.get("document_number")
            payload = await self._client.get(
                "/api/v1/accounting",
                params={"month": parsed["month"], "year": parsed["year"], "process": "payroll"},
            )
            all_items = [item for row in payload.get("data", []) for item in row.get("items", [])]
            emp_items = [it for it in all_items if it.get("employee_rut") == rut or it.get("employee_document_number") == rut]
            if not emp_items:
                return f"No encontré datos de remuneración para {_get_display_name(safe)} en el período {periods[0]}."
            haberes = 0.0
            liquido = None
            for it in emp_items:
                amt = it.get("amount")
                if not isinstance(amt, (int, float)):
                    continue
                if it.get("entry_type") == "debit":
                    haberes += amt
                if LIQUIDO_RE.search(it.get("description") or ""):
                    liquido = amt
            result_obj: dict = {
                "empleado": _get_display_name(safe),
                "periodo": periods[0],
                "total_haberes_clp": haberes,
                "liquido_clp": liquido,
                "fuente": "contabilidad BUK (endpoint real)",
            }
            if wants_uf:
                uf = await _fetch_uf()
                result_obj["total_haberes_uf"] = f"UF {_format_uf(_clp_to_uf(haberes, uf['value']))}"
                result_obj["liquido_uf"] = f"UF {_format_uf(_clp_to_uf(liquido, uf['value']))}" if liquido is not None else None
                result_obj["valor_uf_usado"] = uf["value"]
                result_obj["fecha_uf"] = uf["display"]
            return _compact_json(result_obj)

        # ── Detección de intents ──────────────────────────────────────────────
        has_period_hint = bool(_extract_periods(lower)) or bool(YEAR_RE.search(lower))
        wants_per_employee = any(k in lower for k in ("por empleado", "desglose", "por persona", "cada empleado"))

        is_evolucion = any(k in lower for k in ("evolucion", "evolución", "tendencia planilla", "evolucion mensual", "evolución mensual"))
        is_proyeccion = any(k in lower for k in ("proyeccion", "proyección", "proyectar"))
        is_headcount = "headcount" in lower
        is_ratio = any(k in lower for k in ("ratio", "carga previsional", "eficiencia planilla"))
        is_historical = (
            not is_evolucion and not is_proyeccion and not is_headcount and not is_ratio
            and any(k in lower for k in ("planilla", "liquidacion", "liquidación", "remuneracion", "remuneración", "haberes"))
            and has_period_hint
        )
        is_payroll_total = any(k in lower for k in ("costo total planilla", "total planilla", "total haberes")) and not has_period_hint

        # ── Evolución mensual ────────────────────────────────────────────────
        if is_evolucion:
            year = _extract_year(lower)
            records = await self._fetch_periods_for_year(year)
            if not records:
                return f"No encontré datos de planilla para {year} en BUK."
            evolucion, alerts = _build_evolucion(records)
            resp: dict = {"año": year, "meses_encontrados": len(records), "evolucion": evolucion, "alertas_variacion": alerts or "ninguna"}
            if wants_uf:
                uf = await _fetch_uf()
                resp["evolucion_uf"] = [{"periodo": e["periodo"], "total_uf": f"UF {_format_uf(_clp_to_uf(e['total_clp'], uf['value']))}"} for e in evolucion]
                resp["valor_uf_usado"] = uf["value"]
            return _compact_json(resp)

        # ── Proyección anual ─────────────────────────────────────────────────
        if is_proyeccion:
            year = _extract_year(lower)
            records = await self._fetch_periods_for_year(year)
            if not records:
                return f"No encontré datos de planilla para {year} en BUK."
            proyeccion = _build_proyeccion(records)
            if wants_uf:
                uf = await _fetch_uf()
                proyeccion["proyeccion_anual_uf"] = f"UF {_format_uf(_clp_to_uf(proyeccion['proyeccion_anual_clp'], uf['value']))}"
                proyeccion["promedio_mensual_uf"] = f"UF {_format_uf(_clp_to_uf(proyeccion['promedio_mensual_clp'], uf['value']))}"
                proyeccion["valor_uf_usado"] = uf["value"]
                proyeccion["fecha_uf"] = uf["display"]
            return _compact_json(proyeccion)

        # ── Headcount histórico ──────────────────────────────────────────────
        if is_headcount:
            year = _extract_year(lower)
            records = await self._fetch_periods_for_year(year)
            if not records:
                return f"No encontré datos de headcount para {year} en BUK."
            return _compact_json({"año": year, "headcount": [{"periodo": r["period"], "cantidad_empleados": r["employees_count"]} for r in records]})

        # ── Ratio carga previsional ──────────────────────────────────────────
        if is_ratio:
            year = _extract_year(lower)
            records = await self._fetch_periods_for_year(year)
            if not records:
                return f"No encontré datos para {year} en BUK."
            ratios = []
            for r in records:
                by_emp = _summarize_by_employee(r["payload"])
                total_hab = sum(e["total_haberes_clp"] for e in by_emp)
                total_liq = sum(e["liquido_clp"] or 0 for e in by_emp)
                ratio = round(total_liq / total_hab * 100, 1) if total_hab > 0 and total_liq > 0 else None
                ratios.append({
                    "periodo": r["period"],
                    "total_haberes_brutos_clp": total_hab,
                    "total_liquido_clp": total_liq,
                    "ratio_liquido_pct": f"{ratio}%" if ratio is not None else None,
                    "carga_adicional_pct": f"{round(100 - ratio, 1)}%" if ratio is not None else None,
                })
            return _compact_json({"año": year, "ratio_carga_previsional": ratios})

        # ── Planilla histórica por periodo(s) ────────────────────────────────
        if is_historical:
            periods = _extract_periods(lower)
            if not periods:
                return "No pude identificar periodos. Usa formato YYYY-MM o nombres de meses con año."
            rut_to_name: dict[str, str] = {}
            if wants_per_employee:
                try:
                    emp_result = await self._client.get("/api/v1/employees", params={"status": "activo"})
                    rut_to_name = _build_rut_to_name(_extract_employees(emp_result))
                except Exception:
                    pass
            real_records = []
            failed = []
            for period in periods:
                parsed = _split_period(period)
                if not parsed:
                    failed.append(period)
                    continue
                try:
                    payload = await self._client.get(
                        "/api/v1/accounting",
                        params={"month": parsed["month"], "year": parsed["year"], "process": "payroll"},
                    )
                    summary = _summarize_accounting(payload)
                    per_emp = _summarize_by_employee(payload, rut_to_name) if wants_per_employee else None
                    real_records.append({
                        "period": period,
                        "total_clp": summary["total_debit_clp"],
                        "currency": "CLP",
                        "employees_count": summary["employees_count"],
                        "accounting": summary,
                        "per_employee": per_emp,
                    })
                except Exception:
                    failed.append(period)

            found_set = {r["period"] for r in real_records}
            missing = [p for p in periods if p not in found_set]
            total = sum(r["total_clp"] for r in real_records)
            detalle = []
            for item in real_records:
                d: dict = {
                    "periodo": item["period"],
                    "total_clp": item["total_clp"],
                    "moneda": item["currency"],
                    "cantidad_empleados": item["employees_count"],
                }
                if item.get("per_employee"):
                    d["empleados"] = item["per_employee"]
                else:
                    d["detalle_contable"] = item.get("accounting")
                detalle.append(d)

            resp = {
                "total_periodos_solicitados": len(periods),
                "periodos_encontrados": len(real_records),
                "periodos_faltantes": missing,
                "total_planilla_clp": total,
                "detalle": detalle,
                "fuente": "contabilidad BUK (endpoint real)",
                "convertido_a_uf": wants_uf,
            }
            if failed:
                resp["advertencia"] = "Algunos periodos no están disponibles en contabilidad BUK para este tenant."
            if wants_uf:
                uf = await _fetch_uf()
                for d in detalle:
                    d["total_uf"] = f"UF {_format_uf(_clp_to_uf(d['total_clp'], uf['value']))}"
                resp["total_planilla_uf"] = f"UF {_format_uf(_clp_to_uf(total, uf['value']))}"
                resp["valor_uf_usado"] = uf["value"]
                resp["fecha_uf"] = uf["display"]
            return _compact_json(resp)

        # ── Costo total planilla (sin periodo) ───────────────────────────────
        if is_payroll_total:
            result = await self._client.get("/api/v1/employees", params={"status": "activo"})
            employees = _extract_employees(result)
            total = sum(_get_payroll_amount(e) for e in employees)
            resp = {"total_empleados_activos": len(employees), "costo_total_planilla": total, "filtro": "solo empleados activos"}
            if wants_uf:
                uf = await _fetch_uf()
                resp["costo_total_planilla_uf"] = f"UF {_format_uf(_clp_to_uf(total, uf['value']))}"
                resp["valor_uf_usado"] = uf["value"]
                resp["fecha_uf"] = uf["display"]
            return _compact_json(resp)

        # ── AFP / Salud / Previsión ───────────────────────────────────────────
        if lower.startswith("afp de "):
            query = text[len("afp de "):].strip()
            emp = await self._find_employee_by_name(query)
            if not emp:
                return f"No encontré empleados para: {query}"
            safe = _apply_protection(emp)
            return _compact_json({"empleado": _get_display_name(safe), "afp": safe.get("pension_fund") or "No disponible", "regimen_previsional": safe.get("pension_regime") or "No disponible", "afc": safe.get("afc")})

        if lower.startswith("salud de "):
            query = text[len("salud de "):].strip()
            emp = await self._find_employee_by_name(query)
            if not emp:
                return f"No encontré empleados para: {query}"
            safe = _apply_protection(emp)
            return _compact_json({"empleado": _get_display_name(safe), "isapre_fonasa": safe.get("health_company") or "No disponible"})

        if lower.startswith("prevision de ") or lower.startswith("previsión de "):
            prefix_len = len("prevision de ") if lower.startswith("prevision de ") else len("previsión de ")
            query = text[prefix_len:].strip()
            emp = await self._find_employee_by_name(query)
            if not emp:
                return f"No encontré empleados para: {query}"
            safe = _apply_protection(emp)
            return _compact_json({
                "empleado": _get_display_name(safe),
                "afp": safe.get("pension_fund") or "No disponible",
                "regimen_previsional": safe.get("pension_regime") or "No disponible",
                "afc": safe.get("afc"),
                "isapre_fonasa": safe.get("health_company") or "No disponible",
                "regimen_jubilacion": safe.get("retirement_regime"),
            })

        # ── Historial sueldo ─────────────────────────────────────────────────
        historial_prefixes = ("historial sueldo de ", "variacion sueldo de ", "variación sueldo de ")
        historial_prefix = next((p for p in historial_prefixes if lower.startswith(p)), None)
        if historial_prefix:
            query = text[len(historial_prefix):].strip()
            emp = await self._find_employee_by_name(query)
            if not emp:
                return f"No encontré empleados para: {query}"
            safe = _apply_protection(emp)
            jobs = [
                {
                    "start_date": j.get("start_date"),
                    "end_date": j.get("end_date") or "vigente",
                    "cargo": j.get("role", {}).get("name") if isinstance(j.get("role"), dict) else None,
                    "contrato": j.get("contract_type"),
                    "base_wage": j.get("base_wage"),
                }
                for j in (safe.get("jobs") or [])
            ]
            return _compact_json({"empleado": _get_display_name(safe), "total_contratos": len(jobs), "historial": jobs})

        # ── GET / POST directo ────────────────────────────────────────────────
        if lower.startswith("get "):
            raw_path = text[4:].strip()
            path, _, qs = raw_path.partition("?")
            params = dict(pair.split("=", 1) for pair in qs.split("&") if "=" in pair) if qs else None
            result = await self._client.get(path, params=params)
            if "/employees" in path:
                employees = _extract_employees(result)
                sanitized = [_apply_protection(e) for e in employees]
                return _compact_json(sanitized)
            return _compact_json(result)

        if lower.startswith("post "):
            rest = text[5:].strip()
            space = rest.find(" ")
            if space == -1:
                return "Formato POST inválido. Ejemplo: post /employees {\"name\":\"Ana\"}"
            path = rest[:space].strip()
            raw_body = rest[space + 1:].strip()
            try:
                body = json.loads(raw_body)
            except json.JSONDecodeError:
                return "El body del POST no es JSON válido."
            result = await self._client.post(path, body=body)
            return _compact_json(result)

        return "No reconozco ese comando.\nTip: usa 'ayuda' o prueba con: get /employees?search=juan"

    def _help(self) -> str:
        return "\n".join([
            "Comandos disponibles:",
            "- ayuda",
            "- salir",
            "- ping / ping starter",
            "- uf",
            "- empleados / empleados inactivos / empleados todos",
            "- buscar empleado <texto> [en uf]",
            "- empleado <id> [en uf]",
            "- afp de <nombre>",
            "- salud de <nombre>",
            "- prevision de <nombre>",
            "- historial sueldo de <nombre>",
            "- liquido de <nombre> <mes> <año> [en uf]",
            "- costo total planilla [en uf]",
            "- planilla <YYYY-MM> [en uf]",
            "- planilla enero febrero 2026 [por empleado]",
            "- evolucion planilla <año>",
            "- proyeccion planilla <año> [en uf]",
            "- headcount <año>",
            "- ratio planilla <año> / carga previsional <año>",
            "- get <ruta>[?query]",
            "- post <ruta> <json>",
            "",
            "Ejemplos:",
            "- buscar empleado maria",
            "- liquido de Karen marzo 2026",
            "- planilla por empleado marzo 2026",
            "- evolucion planilla 2026",
            "- proyeccion planilla 2026 en uf",
            "- headcount 2026",
            "- ratio planilla 2026",
        ])
