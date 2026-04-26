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
    nombre: getEmployeeDisplayName(safeEmployee),
    cargo: currentJob?.role?.name || null,
    sueldo_base: currentJob?.base_wage ?? null,
    estado: safeEmployee?.status || null
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

function extractRequestedPeriods(lower) {
  const directPeriods = lower.match(/\b\d{4}-(0[1-9]|1[0-2])\b/g) || [];
  if (directPeriods.length) {
    return [...new Set(directPeriods.filter((period) => PERIOD_RE.test(period)))];
  }

  const yearMatch = lower.match(/\b(20\d{2})\b/);
  if (!yearMatch) {
    return [];
  }

  const year = yearMatch[1];
  const foundMonths = Object.entries(MONTH_TO_NUMBER)
    .filter(([month]) => lower.includes(month))
    .map(([, monthNumber]) => `${year}-${monthNumber}`);

  return [...new Set(foundMonths)];
}

function splitPeriod(period) {
  const normalized = PERIOD_RE.test(period) ? period : null;
  if (!normalized) {
    return null;
  }

  const [yearText, monthText] = normalized.split("-");
  return {
    period: normalized,
    year: Number(yearText),
    month: Number(monthText)
  };
}

function summarizeAccountingPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  let debit = 0;
  let credit = 0;
  let other = 0;
  let lines = 0;

  rows.forEach((row) => {
    const items = Array.isArray(row?.items) ? row.items : [];
    items.forEach((item) => {
      const amount = typeof item?.amount === "number" ? item.amount : Number(item?.amount);
      if (!Number.isFinite(amount)) {
        return;
      }

      lines += 1;
      if (item?.entry_type === "debit") {
        debit += amount;
      } else if (item?.entry_type === "credit") {
        credit += amount;
      } else {
        other += amount;
      }
    });
  });

  return {
    employees_count: rows.length,
    line_items: lines,
    total_debit_clp: debit,
    total_credit_clp: credit,
    total_other_clp: other,
    total_entries_clp: debit + credit + other
  };
}

function summarizeAccountingByEmployee(payload, rutToName = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byRut = new Map();

  rows.forEach((row) => {
    const items = Array.isArray(row?.items) ? row.items : [];
    items.forEach((item) => {
      const rut = item?.employee_rut || item?.employee_document_number || "desconocido";
      const amount = typeof item?.amount === "number" ? item.amount : Number(item?.amount);
      if (!Number.isFinite(amount)) return;

      if (!byRut.has(rut)) {
        byRut.set(rut, { rut, haberes: 0, liquido: null });
      }
      const entry = byRut.get(rut);
      if (item?.entry_type === "debit") {
        entry.haberes += amount;
      }
      // "Líquido a Recibir" is the authoritative net pay item
      if (/l[ií]quido a recibir/i.test(item?.description || "")) {
        entry.liquido = amount;
      }
    });
  });

  return Array.from(byRut.values()).map((e) => ({
    rut: e.rut,
    nombre: rutToName[e.rut] || null,
    total_haberes_clp: e.haberes,
    liquido_clp: e.liquido ?? null
  }));
}

function buildRutToNameMap(employees) {
  const map = {};
  for (const emp of employees) {
    const rut = emp?.rut || emp?.document_number;
    if (rut) {
      map[rut] = emp?.full_name || `${emp?.first_name || ""} ${emp?.surname || ""}`.trim() || rut;
    }
  }
  return map;
}

function buildHistoricalPayrollResponseFromRecords(periods, records, wantsUF, sourceLabel) {
  const byPeriod = new Map(records.map((record) => [record.period, record]));
  const missing = periods.filter((period) => !byPeriod.has(period));
  const found = periods
    .filter((period) => byPeriod.has(period))
    .map((period) => byPeriod.get(period));

  const total = found.reduce((sum, item) => sum + item.total_clp, 0);

  return {
    total_periodos_solicitados: periods.length,
    periodos_encontrados: found.length,
    periodos_faltantes: missing,
    total_planilla_clp: total,
    detalle: found.map((item) => ({
      periodo: item.period,
      total_clp: item.total_clp,
      moneda: item.currency,
      cantidad_empleados: item.employees_count,
      ...(item.per_employee ? { empleados: item.per_employee } : { detalle_contable: item.accounting || null })
    })),
    fuente: sourceLabel,
    convertido_a_uf: wantsUF
  };
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

  async findEmployeeByName(query) {
    const normalizedQuery = normalizeForSearch(query);
    const result = await this.client.get("/api/v1/employees", { search: query });
    const employees = extractEmployees(result);
    const matched = employees.filter((emp) => employeeMatchesQuery(emp, normalizedQuery));

    if (!matched.length) return null;

    const full = await this.client.get(`/api/v1/employees/${encodeURIComponent(matched[0].id)}`);
    return full?.data ?? full;
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

    if (lower === "empleados" || lower === "empleados activos") {
      const result = await this.client.get("/api/v1/employees", { status: "activo" });
      const employees = extractEmployees(result);
      const summaries = employees.map(buildEmployeeSummary);
      return formatResult({ total: summaries.length, estado: "activo", empleados: summaries });
    }

    if (lower === "empleados inactivos") {
      const result = await this.client.get("/api/v1/employees", { status: "inactivo" });
      const employees = extractEmployees(result);
      const summaries = employees.map(buildEmployeeSummary);
      return formatResult({ total: summaries.length, estado: "inactivo", empleados: summaries });
    }

    if (lower === "empleados todos" || lower === "todos los empleados") {
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
          const rawWage = typeof emp.sueldo_base === "number" ? emp.sueldo_base : null;
          return {
            ...emp,
            sueldo_base_uf:
              rawWage !== null && emp.sueldo_base !== REDACTED_TEXT
                ? `UF ${formatUFAmount(clpToUF(rawWage, uf.value))}`
                : emp.sueldo_base
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

    // liquido de <nombre> [en] <mes> <año> | <YYYY-MM>
    const liquidoPrefixes = ["sueldo liquido de ", "monto liquido de ", "liquido de ",
                             "sueldo líquido de ", "monto líquido de ", "líquido de "];
    const liquidoPrefix = liquidoPrefixes.find((p) => lower.startsWith(p));
    if (liquidoPrefix) {
      const suffix = input.slice(liquidoPrefix.length).trim();
      const periods = extractRequestedPeriods(suffix.toLowerCase());
      if (!periods.length) {
        return "Indica el período. Ejemplo: liquido de Juan Pérez marzo 2026";
      }
      const period = periods[0];
      const parsedPeriod = splitPeriod(period);
      if (!parsedPeriod) {
        return `No pude interpretar el período: ${period}`;
      }
      // Remove period tokens from suffix to isolate name
      const nameRaw = suffix
        .replace(/\b\d{4}-(0[1-9]|1[0-2])\b/g, "")
        .replace(
          new RegExp(`\\b(${Object.keys(MONTH_TO_NUMBER).join("|")})\\b`, "gi"),
          ""
        )
        .replace(/\b20\d{2}\b/g, "")
        .replace(/\ben\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!nameRaw) {
        return "No pude identificar el nombre del empleado.";
      }
      const employee = await this.findEmployeeByName(nameRaw);
      if (!employee) return `No encontré empleados para: ${nameRaw}`;
      const safe = applyProtectedEmployeePolicy(employee);
      const employeeRut = safe?.rut || safe?.document_number;

      const payload = await this.client.get("/api/v1/accounting", {
        month: parsedPeriod.month,
        year: parsedPeriod.year,
        process: "payroll"
      });
      const allRows = Array.isArray(payload?.data) ? payload.data : [];
      const items = allRows.flatMap((row) => row.items || []);
      const empItems = items.filter(
        (it) => it?.employee_rut === employeeRut || it?.employee_document_number === employeeRut
      );

      if (!empItems.length) {
        return `No encontré datos de remuneración para ${getEmployeeDisplayName(safe)} en el período ${period}.`;
      }

      let haberes = 0;
      let liquido = null;
      for (const it of empItems) {
        const amt = typeof it.amount === "number" ? it.amount : Number(it.amount);
        if (!Number.isFinite(amt)) continue;
        if (it.entry_type === "debit") haberes += amt;
        if (/l[ií]quido a recibir/i.test(it.description || "")) liquido = amt;
      }

      if (!wantsUF) {
        return formatResult({
          empleado: getEmployeeDisplayName(safe),
          periodo: period,
          total_haberes_clp: haberes,
          liquido_clp: liquido,
          fuente: "contabilidad BUK (endpoint real)"
        });
      }

      const uf = await fetchUF();
      return formatResult({
        empleado: getEmployeeDisplayName(safe),
        periodo: period,
        total_haberes_clp: haberes,
        total_haberes_uf: `UF ${formatUFAmount(clpToUF(haberes, uf.value))}`,
        liquido_clp: liquido,
        liquido_uf: liquido !== null ? `UF ${formatUFAmount(clpToUF(liquido, uf.value))}` : null,
        valor_uf_usado: uf.value,
        fecha_uf: uf.fechaDisplay,
        fuente: "contabilidad BUK (endpoint real)"
      });
    }

    const payrollKeywords =
      lower.includes("costo total planilla") ||
      lower.includes("total planilla") ||
      lower.includes("total haberes");

    const hasPeriodHint = extractRequestedPeriods(lower).length > 0 || /\b20\d{2}\b/.test(lower);

    const wantsPerEmployee =
      lower.includes("por empleado") ||
      lower.includes("desglose") ||
      lower.includes("por persona") ||
      lower.includes("cada empleado");

    const historicalPayrollIntent =
      (lower.includes("planilla") || lower.includes("liquidacion") || lower.includes("liquidación") ||
       lower.includes("remuneracion") || lower.includes("remuneración") || lower.includes("haberes")) &&
      hasPeriodHint;

    if (historicalPayrollIntent) {
      const periods = extractRequestedPeriods(lower);
      if (!periods.length) {
        return "No pude identificar periodos. Usa formato YYYY-MM o meses con año, por ejemplo: costo planilla enero y febrero 2026.";
      }

      const realRecords = [];
      const failedPeriods = [];

      // If per-employee breakdown requested, fetch employee names once
      let rutToName = {};
      if (wantsPerEmployee) {
        try {
          const empResult = await this.client.get("/api/v1/employees", { status: "activo" });
          rutToName = buildRutToNameMap(extractEmployees(empResult));
        } catch (_e) { /* name resolution best-effort */ }
      }

      for (const period of periods) {
        const parsedPeriod = splitPeriod(period);
        if (!parsedPeriod) {
          failedPeriods.push(period);
          continue;
        }

        try {
          const payload = await this.client.get("/api/v1/accounting", {
            month: parsedPeriod.month,
            year: parsedPeriod.year,
            process: "payroll"
          });
          const accounting = summarizeAccountingPayload(payload);
          const perEmployee = wantsPerEmployee
            ? summarizeAccountingByEmployee(payload, rutToName)
            : null;
          realRecords.push({
            period,
            total_clp: accounting.total_debit_clp,
            currency: "CLP",
            employees_count: accounting.employees_count,
            accounting,
            per_employee: perEmployee
          });
        } catch (_error) {
          failedPeriods.push(period);
        }
      }

      const baseResponse = buildHistoricalPayrollResponseFromRecords(
        periods,
        realRecords,
        wantsUF,
        "contabilidad BUK (endpoint real)"
      );

      if (failedPeriods.length) {
        baseResponse.advertencia =
          "Algunos periodos no estan disponibles en contabilidad BUK para este tenant.";
      }

      if (!wantsUF) {
        return formatResult(baseResponse);
      }

      const uf = await fetchUF();
      const detalleUF = baseResponse.detalle.map((item) => ({
        ...item,
        total_uf: `UF ${formatUFAmount(clpToUF(item.total_clp, uf.value))}`
      }));

      return formatResult({
        ...baseResponse,
        detalle: detalleUF,
        total_planilla_uf: `UF ${formatUFAmount(clpToUF(baseResponse.total_planilla_clp, uf.value))}`,
        valor_uf_usado: uf.value,
        fecha_uf: uf.fechaDisplay,
        convertido_a_uf: true
      });
    }

    if (payrollKeywords) {
      const result = await this.client.get("/api/v1/employees", { status: "activo" });
      const employees = extractEmployees(result);
      const total = employees.reduce(
        (sum, employee) => sum + getPayrollAmount(employee),
        0
      );

      if (wantsUF) {
        const uf = await fetchUF();
        const totalUF = clpToUF(total, uf.value);
        return formatResult({
          total_empleados_activos: employees.length,
          costo_total_planilla_clp: total,
          costo_total_planilla_uf: `UF ${formatUFAmount(totalUF)}`,
          valor_uf_usado: uf.value,
          fecha_uf: uf.fechaDisplay,
          filtro: "solo empleados activos"
        });
      }

      return formatResult({
        total_empleados_activos: employees.length,
        costo_total_planilla: total,
        filtro: "solo empleados activos"
      });
    }

    if (lower.startsWith("afp de ")) {
      const query = input.slice("afp de ".length).trim();
      const employee = await this.findEmployeeByName(query);
      if (!employee) return `No encontré empleados para: ${query}`;
      const safe = applyProtectedEmployeePolicy(employee);
      return formatResult({
        empleado: getEmployeeDisplayName(safe),
        afp: safe.pension_fund || "No disponible",
        regimen_previsional: safe.pension_regime || "No disponible",
        afc: safe.afc ?? null
      });
    }

    if (lower.startsWith("salud de ")) {
      const query = input.slice("salud de ".length).trim();
      const employee = await this.findEmployeeByName(query);
      if (!employee) return `No encontré empleados para: ${query}`;
      const safe = applyProtectedEmployeePolicy(employee);
      return formatResult({
        empleado: getEmployeeDisplayName(safe),
        isapre_fonasa: safe.health_company || "No disponible"
      });
    }

    if (lower.startsWith("prevision de ")) {
      const query = input.slice("prevision de ".length).trim();
      const employee = await this.findEmployeeByName(query);
      if (!employee) return `No encontré empleados para: ${query}`;
      const safe = applyProtectedEmployeePolicy(employee);
      return formatResult({
        empleado: getEmployeeDisplayName(safe),
        afp: safe.pension_fund || "No disponible",
        regimen_previsional: safe.pension_regime || "No disponible",
        afc: safe.afc ?? null,
        isapre_fonasa: safe.health_company || "No disponible",
        regimen_jubilacion: safe.retirement_regime || null
      });
    }

    if (
      lower.startsWith("historial sueldo de ") ||
      lower.startsWith("variacion sueldo de ") ||
      lower.startsWith("variación sueldo de ")
    ) {
      const prefixLen = lower.startsWith("historial sueldo de ")
        ? "historial sueldo de ".length
        : "variacion sueldo de ".length;
      const query = input.slice(prefixLen).trim();
      const employee = await this.findEmployeeByName(query);
      if (!employee) return `No encontré empleados para: ${query}`;
      const safe = applyProtectedEmployeePolicy(employee);
      const jobs = (safe.jobs || []).map((job) => ({
        start_date: job.start_date,
        end_date: job.end_date || "vigente",
        cargo: job.role?.name || null,
        contrato: job.contract_type,
        base_wage: job.base_wage
      }));
      return formatResult({
        empleado: getEmployeeDisplayName(safe),
        total_contratos: jobs.length,
        historial: jobs
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
      "- afp de <nombre>",
      "- salud de <nombre>",
      "- prevision de <nombre>",
      "- historial sueldo de <nombre>",
      "- liquido de <nombre> <mes> <año>",
      "- sueldo liquido de <nombre> <mes> <año>",
      "- costo planilla <YYYY-MM>",
      "- costo planilla enero y febrero 2026",
      "- costo planilla por empleado marzo 2026",
      "- costo planilla marzo 2026 en uf",
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
