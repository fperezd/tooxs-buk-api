import { BukClient } from "./bukClient.js";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[tT ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([zZ]|[+-]\d{2}:?\d{2})?$/;
const MONEY_KEY_RE =
  /(wage|salary|sueldo|monto|amount|price|precio|cost|costo|total|payment|pago|liquid|remuneracion|haber)/i;
const PROTECTED_EMPLOYEE_RULES = [
  {
    id: "fernando-perez",
    requiredNameTokens: ["fernando", "perez"]
  }
];
const REDACTED_TEXT = "restringido";
const CONTRACTUAL_FIELDS_TO_REDACT = [
  "contract_type",
  "notice_date",
  "contract_finishing_date_1",
  "contract_finishing_date_2",
  "weekly_hours",
  "working_schedule_type",
  "periodicity",
  "frequency",
  "contract_subscription_date",
  "without_wage",
  "other_type_of_working_day",
  "base_wage",
  "contractual_stipulation",
  "contractual_detail",
  "reward",
  "reward_concept",
  "reward_payment_period",
  "reward_description"
];

function formatLatinDate(rawValue) {
  if (DATE_ONLY_RE.test(rawValue)) {
    const [year, month, day] = rawValue.split("-");
    return `${day}/${month}/${year}`;
  }

  if (ISO_DATETIME_RE.test(rawValue)) {
    const date = new Date(rawValue);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("es-CL", {
        dateStyle: "short",
        timeStyle: "medium",
        hour12: false
      }).format(date);
    }
  }

  return rawValue;
}

function formatLatinNumber(value) {
  return new Intl.NumberFormat("es-CL").format(value);
}

function formatCLP(value) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0
  }).format(value);
}

function shouldFormatAsMoney(key) {
  if (!key) {
    return false;
  }

  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey === "total" ||
    normalizedKey.includes("total_empleados") ||
    normalizedKey.includes("cantidad") ||
    normalizedKey.includes("count") ||
    normalizedKey.includes("numero")
  ) {
    return false;
  }

  return MONEY_KEY_RE.test(key);
}

function formatForLatinDisplay(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => formatForLatinDisplay(item, key));
  }

  if (value && typeof value === "object") {
    const formatted = {};
    Object.entries(value).forEach(([entryKey, entryValue]) => {
      formatted[entryKey] = formatForLatinDisplay(entryValue, entryKey);
    });
    return formatted;
  }

  if (typeof value === "string") {
    return formatLatinDate(value);
  }

  if (typeof value === "number") {
    if (shouldFormatAsMoney(key)) {
      return formatCLP(value);
    }
    return formatLatinNumber(value);
  }

  return value;
}

function parseJsonSafely(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalize(text) {
  return text.trim().toLowerCase();
}

function normalizeForSearch(value) {
  return (value || "")
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function extractEmployees(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }

  return [];
}

function employeeMatchesQuery(employee, query) {
  const haystack = [
    employee?.full_name,
    employee?.name,
    employee?.first_name,
    employee?.surname,
    employee?.second_surname,
    employee?.email,
    employee?.rut,
    employee?.document_number
  ]
    .map(normalizeForSearch)
    .join(" ");

  return haystack.includes(query);
}

function getEmployeeDisplayName(employee) {
  return (
    employee?.full_name ||
    employee?.name ||
    [employee?.first_name, employee?.surname, employee?.second_surname]
      .filter(Boolean)
      .join(" ")
  );
}

function isProtectedEmployee(employee) {
  const normalizedName = normalizeForSearch(getEmployeeDisplayName(employee));

  return PROTECTED_EMPLOYEE_RULES.some((rule) =>
    rule.requiredNameTokens.every((token) => normalizedName.includes(token))
  );
}

function redactContractualFieldsInJob(job) {
  if (!job || typeof job !== "object") {
    return job;
  }

  const clonedJob = { ...job };
  CONTRACTUAL_FIELDS_TO_REDACT.forEach((field) => {
    if (field in clonedJob) {
      clonedJob[field] = REDACTED_TEXT;
    }
  });

  return clonedJob;
}

function applyProtectedEmployeePolicy(employee) {
  if (!isProtectedEmployee(employee)) {
    return employee;
  }

  const clonedEmployee = { ...employee };

  if (clonedEmployee.current_job) {
    clonedEmployee.current_job = redactContractualFieldsInJob(clonedEmployee.current_job);
  }

  if (Array.isArray(clonedEmployee.jobs)) {
    clonedEmployee.jobs = clonedEmployee.jobs.map(redactContractualFieldsInJob);
  }

  return clonedEmployee;
}

function getPayrollAmount(employee) {
  const candidates = [
    employee?.current_job?.total_haberes,
    employee?.current_job?.total_assets,
    employee?.total_haberes,
    employee?.total_assets,
    employee?.current_job?.base_wage
  ];

  const amount = candidates.find(
    (value) => typeof value === "number" && Number.isFinite(value)
  );

  return amount ?? 0;
}

function sanitizeEmployeePayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map(applyProtectedEmployeePolicy);
  }

  if (payload && Array.isArray(payload.data)) {
    return {
      ...payload,
      data: payload.data.map(applyProtectedEmployeePolicy)
    };
  }

  if (payload && payload.data && typeof payload.data === "object") {
    return {
      ...payload,
      data: applyProtectedEmployeePolicy(payload.data)
    };
  }

  if (payload && typeof payload === "object") {
    return applyProtectedEmployeePolicy(payload);
  }

  return payload;
}

function buildEmployeeSummary(employee) {
  const safeEmployee = applyProtectedEmployeePolicy(employee);
  const currentJob = safeEmployee?.current_job || {};

  return {
    id: safeEmployee?.id ?? null,
    full_name: getEmployeeDisplayName(safeEmployee),
    rut: safeEmployee?.rut || safeEmployee?.document_number || null,
    email: safeEmployee?.email || null,
    status: safeEmployee?.status || null,
    role: currentJob?.role?.name || null,
    contract_type: currentJob?.contract_type || null,
    start_date: currentJob?.start_date || null,
    base_wage: currentJob?.base_wage ?? null,
    privacy_policy_applied: isProtectedEmployee(safeEmployee)
  };
}

// ---------- UF (Unidad de Fomento) ----------

const ufCache = { value: null, dateISO: null };

async function fetchUF() {
  const todayISO = new Date().toISOString().slice(0, 10);

  if (ufCache.dateISO === todayISO && ufCache.value !== null) {
    return ufCache;
  }

  // mindicador.cl agrega datos oficiales del Banco Central de Chile
  const response = await fetch("https://mindicador.cl/api/uf");
  if (!response.ok) {
    throw new Error(`Error al consultar indicadores (${response.status})`);
  }

  const data = await response.json();
  const valor = data?.serie?.[0]?.valor;
  const fechaRaw = data?.serie?.[0]?.fecha;

  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    throw new Error("Respuesta de UF inesperada desde mindicador.cl");
  }

  const fechaDisplay = fechaRaw
    ? new Date(fechaRaw).toLocaleDateString("es-CL", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "America/Santiago"
      })
    : todayISO;

  ufCache.value = valor;
  ufCache.dateISO = todayISO;
  ufCache.fechaDisplay = fechaDisplay;

  return ufCache;
}

function formatUFAmount(ufAmount) {
  return new Intl.NumberFormat("es-CL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(ufAmount);
}

function clpToUF(clpAmount, ufValue) {
  return clpAmount / ufValue;
}

// ---------- path helpers ----------

function extractPathAndQuery(rawPath) {
  const [path, queryString] = rawPath.split("?");
  const query = {};

  if (queryString) {
    const params = new URLSearchParams(queryString);
    for (const [key, value] of params.entries()) {
      query[key] = value;
    }
  }

  return { path, query };
}

function formatResult(result) {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(formatForLatinDisplay(result), null, 2);
}

export class BukConversationalAgent {
  constructor(client = new BukClient()) {
    this.client = client;
  }

  async handleInput(rawInput) {
    const input = rawInput.trim();
    const lower = normalize(input);

    if (!input) {
      return "Escribe un comando. Usa 'ayuda' para ver ejemplos.";
    }

    if (["salir", "exit", "quit"].includes(lower)) {
      return { shouldExit: true, message: "Cerrando agente BUK." };
    }

    if (["ayuda", "help", "?"].includes(lower)) {
      return this.helpMessage();
    }

    if (lower === "ping starter") {
      const result = await this.client.pingStarter();
      return `Starter OK:\n${formatResult(result)}`;
    }

    if (lower === "ping") {
      const result = await this.client.get("/");
      return `Ping OK:\n${formatResult(result)}`;
    }

    const wantsUF =
      lower.endsWith(" en uf") ||
      lower.endsWith(" en ufs") ||
      lower.includes(" en uf ");

    if (["uf", "valor uf", "uf hoy", "uf del dia", "uf del día"].includes(lower)) {
      const uf = await fetchUF();
      return `UF del ${uf.fechaDisplay}: ${formatCLP(uf.value)}`;
    }

    if (lower === "empleados") {
      const result = await this.client.get("/api/v1/employees");
      const employees = extractEmployees(result);
      const summaries = employees.map(buildEmployeeSummary);
      return formatResult({ total: summaries.length, empleados: summaries });
    }

    if (lower.startsWith("buscar empleado ")) {
      const rawSuffix = input.slice("buscar empleado ".length).trim();
      const query = wantsUF
        ? rawSuffix.replace(/\s+en\s+ufs?$/i, "").trim()
        : rawSuffix;
      const normalizedQuery = normalizeForSearch(query);
      const result = await this.client.get("/api/v1/employees", { search: query });
      const employees = extractEmployees(result);
      const matched = employees.filter((employee) =>
        employeeMatchesQuery(employee, normalizedQuery)
      );

      if (!matched.length) {
        return `No encontre empleados para: ${query}`;
      }

      const summaries = matched.map(buildEmployeeSummary);

      if (wantsUF) {
        const uf = await fetchUF();
        const summariesUF = summaries.map((emp) => {
          const rawWage = typeof emp.base_wage === "number" ? emp.base_wage : null;
          return {
            ...emp,
            base_wage_uf:
              rawWage !== null && emp.base_wage !== REDACTED_TEXT
                ? `UF ${formatUFAmount(clpToUF(rawWage, uf.value))}`
                : emp.base_wage
          };
        });
        return formatResult({
          query,
          total: summariesUF.length,
          valor_uf: uf.value,
          fecha_uf: uf.fechaDisplay,
          data: summariesUF
        });
      }

      return formatResult({ query, total: summaries.length, data: summaries });
    }

    if (lower.startsWith("empleado ")) {
      const rawSuffix = input.slice("empleado ".length).trim();
      const id = wantsUF
        ? rawSuffix.replace(/\s+en\s+ufs?$/i, "").trim()
        : rawSuffix;
      const result = await this.client.get(`/api/v1/employees/${encodeURIComponent(id)}`);
      const safeResult = sanitizeEmployeePayload(result);

      if (wantsUF) {
        const uf = await fetchUF();
        const employee = safeResult?.data ?? safeResult;
        const wage = getPayrollAmount(employee);
        const wageUF = clpToUF(wage, uf.value);
        return formatResult({
          ...formatForLatinDisplay(safeResult),
          sueldo_base_uf: `UF ${formatUFAmount(wageUF)}`,
          valor_uf_usado: uf.value,
          fecha_uf: uf.fechaDisplay
        });
      }

      return formatResult(safeResult);
    }

    const payrollKeywords =
      lower.includes("costo total planilla") ||
      lower.includes("total planilla") ||
      lower.includes("total haberes");

    if (payrollKeywords) {
      const result = await this.client.get("/api/v1/employees");
      const employees = extractEmployees(result);
      const total = employees.reduce(
        (sum, employee) => sum + getPayrollAmount(employee),
        0
      );

      if (wantsUF) {
        const uf = await fetchUF();
        const totalUF = clpToUF(total, uf.value);
        return formatResult({
          total_empleados_considerados: employees.length,
          costo_total_planilla_clp: total,
          costo_total_planilla_uf: `UF ${formatUFAmount(totalUF)}`,
          valor_uf_usado: uf.value,
          fecha_uf: uf.fechaDisplay,
          incluye_empleados_con_restriccion_contractual: true
        });
      }

      return formatResult({
        total_empleados_considerados: employees.length,
        costo_total_planilla: total,
        incluye_empleados_con_restriccion_contractual: true
      });
    }

    if (lower.startsWith("get ")) {
      const rawPath = input.slice(4).trim();
      const { path, query } = extractPathAndQuery(rawPath);
      const result = await this.client.get(path, query);

      if (path.includes("/employees")) {
        return formatResult(sanitizeEmployeePayload(result));
      }

      return formatResult(result);
    }

    if (lower.startsWith("post ")) {
      const firstSpaceAfterPath = input.indexOf(" ", 5);
      if (firstSpaceAfterPath === -1) {
        return "Formato POST invalido. Ejemplo: post /employees {\"name\":\"Ana\"}";
      }

      const path = input.slice(5, firstSpaceAfterPath).trim();
      const rawBody = input.slice(firstSpaceAfterPath + 1).trim();
      const parsed = parseJsonSafely(rawBody);
      if (!parsed.ok) {
        return "El body del POST no es JSON valido.";
      }

      const result = await this.client.post(path, parsed.value);
      return formatResult(result);
    }

    return [
      "No reconozco ese comando.",
      "Tip: usa 'ayuda' o prueba con: get /employees?search=juan"
    ].join("\n");
  }

  helpMessage() {
    return [
      "Comandos disponibles:",
      "- ayuda",
      "- salir",
      "- ping",
      "- ping starter",
      "- empleados",
      "- buscar empleado <texto>",
      "- empleado <id>",
      "- costo total planilla",
      "- costo total planilla en uf",
      "- empleado <id> en uf",
      "- buscar empleado <texto> en uf",
      "- uf  (valor UF del dia)",
      "- get <ruta>[?query]",
      "- post <ruta> <json>",
      "",
      "Ejemplos:",
      "- buscar empleado maria",
      "- empleado 12345",
      "- ping starter",
      "- empleados",
      "- costo total planilla",
      "- get /employees?search=martin",
      "- post /employees {\"name\":\"Ana\",\"last_name\":\"Perez\"}"
    ].join("\n");
  }
}
