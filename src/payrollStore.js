import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "payroll-records.json");
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, "[]\n", "utf8");
  }
}

function readRecords() {
  ensureStoreFile();
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeRecords(records) {
  ensureStoreFile();
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function parseAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\./g, "").replace(/,/g, ".").replace(/[^0-9.-]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePeriod(period) {
  const value = String(period || "").trim();
  if (!PERIOD_RE.test(value)) {
    return null;
  }
  return value;
}

function normalizeRecord(input, source = "manual") {
  const period = normalizePeriod(input?.period || input?.periodo || input?.month || input?.mes);
  if (!period) {
    throw new Error("Periodo invalido. Usa formato YYYY-MM (ej: 2026-03).");
  }

  const amount = parseAmount(
    input?.total_clp ?? input?.total ?? input?.total_haberes ?? input?.total_assets ?? input?.monto
  );

  if (amount === null) {
    throw new Error(`Total invalido para periodo ${period}.`);
  }

  const employeesCount = parseAmount(input?.employees_count ?? input?.employee_count ?? input?.cantidad_empleados);

  return {
    period,
    total_clp: amount,
    currency: input?.currency || input?.moneda || "CLP",
    employees_count: employeesCount === null ? null : employeesCount,
    source,
    created_at: new Date().toISOString(),
    raw: input
  };
}

export function upsertPayrollRecord(input, source = "manual") {
  const record = normalizeRecord(input, source);
  const records = readRecords();
  const existingIndex = records.findIndex((item) => item.period === record.period);

  if (existingIndex >= 0) {
    records[existingIndex] = { ...records[existingIndex], ...record };
  } else {
    records.push(record);
  }

  records.sort((a, b) => a.period.localeCompare(b.period));
  writeRecords(records);

  return record;
}

export function upsertPayrollRecords(inputs, source = "manual") {
  if (!Array.isArray(inputs) || !inputs.length) {
    throw new Error("Debes enviar al menos un registro.");
  }

  const saved = [];
  inputs.forEach((entry) => {
    saved.push(upsertPayrollRecord(entry, source));
  });

  return saved;
}

export function getPayrollByPeriod(period) {
  const normalized = normalizePeriod(period);
  if (!normalized) {
    return null;
  }

  const records = readRecords();
  return records.find((item) => item.period === normalized) || null;
}

export function listPayrollPeriods() {
  return readRecords().map((item) => item.period);
}

export function getPayrollRecordsByPeriods(periods) {
  const records = readRecords();
  const periodSet = new Set(periods);
  return records.filter((item) => periodSet.has(item.period));
}
