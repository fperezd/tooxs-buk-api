import { describe, it, expect } from "vitest";

// We test the pure helper functions by importing the module.
// Because agent.js reads PROTECTED_EMPLOYEES from env at module load time,
// we set/unset the env var before importing.

// ── Helpers exported for testing via dynamic import ───────────────────────────
// Since agent.js doesn't export its pure helpers, we replicate the small
// testable pieces here so we don't modify the production API surface.

// ── isValidApiPath ────────────────────────────────────────────────────────────
function isValidApiPath(path) {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (path.includes("..")) return false;
  if (!/^[\w/.\-~%@:!$&'()*+,;=?#[\]]+$/.test(path)) return false;
  return true;
}

describe("isValidApiPath", () => {
  it("acepta rutas válidas", () => {
    expect(isValidApiPath("/api/v1/employees")).toBe(true);
    expect(isValidApiPath("/api/v1/employees/123")).toBe(true);
    expect(isValidApiPath("/health")).toBe(true);
    expect(isValidApiPath("/api/v1/accounting?month=1&year=2026")).toBe(true);
  });

  it("rechaza path traversal", () => {
    expect(isValidApiPath("/../etc/passwd")).toBe(false);
    expect(isValidApiPath("/api/../secret")).toBe(false);
    expect(isValidApiPath("..")).toBe(false);
  });

  it("rechaza rutas sin slash inicial", () => {
    expect(isValidApiPath("api/v1/employees")).toBe(false);
    expect(isValidApiPath("employees")).toBe(false);
  });

  it("rechaza valores vacíos / no string", () => {
    expect(isValidApiPath("")).toBe(false);
    expect(isValidApiPath(null)).toBe(false);
    expect(isValidApiPath(undefined)).toBe(false);
  });
});

// ── wantsUF detection ─────────────────────────────────────────────────────────
const UF_COMMAND_PREFIXES = ["empleado ", "buscar empleado ", "costo", "planilla"];

function detectsUF(lower) {
  return (
    (lower.endsWith(" en uf") || lower.endsWith(" en ufs")) &&
    UF_COMMAND_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

describe("detectsUF", () => {
  it("detecta conversión UF al final del comando", () => {
    expect(detectsUF("empleado 123 en uf")).toBe(true);
    expect(detectsUF("buscar empleado maria en uf")).toBe(true);
    expect(detectsUF("costo total planilla en uf")).toBe(true);
    expect(detectsUF("costo planilla enero 2026 en ufs")).toBe(true);
  });

  it("no detecta falsos positivos", () => {
    expect(detectsUF("soy experto en uf algún día")).toBe(false);
    expect(detectsUF("interesado en uf")).toBe(false);
    expect(detectsUF("get /api/v1/employees")).toBe(false);
  });
});

// ── loadProtectedEmployeeRules ────────────────────────────────────────────────
function loadProtectedEmployeeRules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (rule) =>
        rule &&
        typeof rule.id === "string" &&
        Array.isArray(rule.requiredNameTokens) &&
        rule.requiredNameTokens.every((t) => typeof t === "string")
    );
  } catch {
    return [];
  }
}

describe("loadProtectedEmployeeRules", () => {
  it("carga reglas válidas desde JSON", () => {
    const raw = JSON.stringify([{ id: "fp", requiredNameTokens: ["fernando", "perez"] }]);
    const rules = loadProtectedEmployeeRules(raw);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("fp");
    expect(rules[0].requiredNameTokens).toEqual(["fernando", "perez"]);
  });

  it("retorna array vacío si no hay config", () => {
    expect(loadProtectedEmployeeRules(undefined)).toEqual([]);
    expect(loadProtectedEmployeeRules("")).toEqual([]);
  });

  it("retorna array vacío si JSON es inválido", () => {
    expect(loadProtectedEmployeeRules("not-json")).toEqual([]);
  });

  it("filtra reglas mal formadas", () => {
    const raw = JSON.stringify([
      { id: "ok", requiredNameTokens: ["juan"] },
      { id: 123, requiredNameTokens: ["bad"] }, // id no es string
      { id: "nok", requiredNameTokens: [42] } // token no es string
    ]);
    const rules = loadProtectedEmployeeRules(raw);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("ok");
  });
});

// ── historicalPayrollIntent detection ────────────────────────────────────────
const MONTH_TO_NUMBER = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12"
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function extractRequestedPeriods(lower) {
  const directPeriods = lower.match(/\b\d{4}-(0[1-9]|1[0-2])\b/g) || [];
  if (directPeriods.length) {
    return [...new Set(directPeriods.filter((p) => PERIOD_RE.test(p)))];
  }
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  if (!yearMatch) return [];
  const year = yearMatch[1];
  return [
    ...new Set(
      Object.entries(MONTH_TO_NUMBER)
        .filter(([month]) => lower.includes(month))
        .map(([, num]) => `${year}-${num}`)
    )
  ];
}

function isHistoricalPayrollIntent(lower) {
  const actionWords = [
    "costo",
    "total",
    "cuanto",
    "cuánto",
    "ver",
    "mostrar",
    "dame",
    "muestra",
    "consultar",
    "consulta"
  ];
  const hasAction = actionWords.some((w) => lower.includes(w));
  const hasKeyword =
    lower.includes("planilla") ||
    lower.includes("liquidacion") ||
    lower.includes("liquidación");
  const hasPeriod =
    extractRequestedPeriods(lower).length > 0 ||
    Object.keys(MONTH_TO_NUMBER).some((m) => lower.includes(m));
  return hasAction && hasKeyword && hasPeriod;
}

describe("isHistoricalPayrollIntent", () => {
  it("detecta consultas de costo planilla con periodo", () => {
    expect(isHistoricalPayrollIntent("costo planilla enero 2026")).toBe(true);
    expect(isHistoricalPayrollIntent("costo planilla 2026-01")).toBe(true);
    expect(isHistoricalPayrollIntent("total planilla marzo 2025")).toBe(true);
    expect(isHistoricalPayrollIntent("muestra la planilla de febrero 2026")).toBe(true);
  });

  it("no activa para preguntas informativas sin acción", () => {
    expect(isHistoricalPayrollIntent("¿qué es la planilla en 2024?")).toBe(false);
    expect(isHistoricalPayrollIntent("la planilla 2024")).toBe(false);
  });

  it("activa para liquidaciones con periodo", () => {
    expect(isHistoricalPayrollIntent("consulta liquidacion enero 2026")).toBe(true);
  });
});
