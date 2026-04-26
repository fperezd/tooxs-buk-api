import express from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import { BukConversationalAgent } from "./agent.js";
import { config } from "./config.js";
import {
  getPayrollByPeriod,
  listPayrollPeriods,
  upsertPayrollRecord,
  upsertPayrollRecords
} from "./payrollStore.js";

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const agent = new BukConversationalAgent();

// ── Middleware de autenticación por API key ──────────────────────────────────
function requireApiKey(req, res, next) {
  const serverApiKey = process.env.SERVER_API_KEY;
  if (!serverApiKey) {
    // Si no está configurada la clave, rechazar siempre para evitar exposición
    res.status(503).json({ error: "Servidor no configurado correctamente." });
    return;
  }

  const provided =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  if (provided !== serverApiKey) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }

  next();
}

function requireWebhookSecret(req, res, next) {
  const secret = process.env.BUK_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: "BUK_WEBHOOK_SECRET no configurado." });
    return;
  }

  const provided = req.headers["x-webhook-secret"];
  if (provided !== secret) {
    res.status(401).json({ error: "Webhook no autorizado." });
    return;
  }

  next();
}

function parsePayrollCsv(buffer) {
  const text = buffer.toString("utf8");
  const records = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  return records.map((row) => ({
    period: row.period || row.periodo || row.mes,
    total_clp: row.total_clp || row.total || row.total_haberes || row.monto,
    currency: row.currency || row.moneda || "CLP",
    employees_count: row.employees_count || row.cantidad_empleados || row.employee_count
  }));
}

// ── Health check (público, sin auth) ────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "Ok!", mode: config.mode });
});

// ── Planilla real: carga manual e integración webhook ───────────────────────
app.post("/payroll/upload-json", requireApiKey, (req, res) => {
  try {
    const payload = req.body;

    if (Array.isArray(payload)) {
      const saved = upsertPayrollRecords(payload, "manual_json");
      res.status(201).json({ saved: saved.length, periods: saved.map((item) => item.period) });
      return;
    }

    const saved = upsertPayrollRecord(payload, "manual_json");
    res.status(201).json({ saved: 1, period: saved.period });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/payroll/upload-csv", requireApiKey, upload.single("file"), (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "Debes enviar un archivo CSV en el campo 'file'." });
      return;
    }

    const records = parsePayrollCsv(req.file.buffer);
    const saved = upsertPayrollRecords(records, "manual_csv");
    res.status(201).json({ saved: saved.length, periods: saved.map((item) => item.period) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/webhooks/buk/payroll", requireWebhookSecret, (req, res) => {
  try {
    const payload = req.body?.data || req.body;
    const saved = upsertPayrollRecord(payload, "buk_webhook");
    res.status(202).json({ ok: true, period: saved.period });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/payroll/periods", requireApiKey, (_req, res) => {
  const periods = listPayrollPeriods();
  res.json({ total: periods.length, periods });
});

app.get("/payroll/:period", requireApiKey, (req, res) => {
  const record = getPayrollByPeriod(req.params.period);
  if (!record) {
    res.status(404).json({ error: "No existe planilla para ese periodo." });
    return;
  }

  res.json(record);
});

// ── Endpoint principal: POST /chat ───────────────────────────────────────────
// Body: { "message": "costo total planilla en uf" }
// Response: { "response": "..." }
app.post("/chat", requireApiKey, async (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "El campo 'message' es requerido." });
    return;
  }

  try {
    const result = await agent.handleInput(message);

    if (typeof result === "object" && result?.shouldExit) {
      res.status(400).json({ error: "Comando no permitido en modo API." });
      return;
    }

    res.json({ response: result });
  } catch (error) {
    console.error("Error al procesar mensaje:", error.message);
    res.status(500).json({ error: "Error interno al procesar la solicitud." });
  }
});

// ── Endpoint alternativo: GET /query?message=... ─────────────────────────────
app.get("/query", requireApiKey, async (req, res) => {
  const message = req.query?.message;

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "El parámetro 'message' es requerido." });
    return;
  }

  try {
    const result = await agent.handleInput(message);

    if (typeof result === "object" && result?.shouldExit) {
      res.status(400).json({ error: "Comando no permitido en modo API." });
      return;
    }

    res.json({ response: result });
  } catch (error) {
    console.error("Error al procesar query:", error.message);
    res.status(500).json({ error: "Error interno al procesar la solicitud." });
  }
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor BUK API escuchando en puerto ${PORT} (modo: ${config.mode})`);

  // Keep-alive: ping propio cada 10 minutos para evitar que Render lo duerma
  const selfUrl = process.env.SELF_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${selfUrl}/health`)
      .then(() => console.log("[keep-alive] ping ok"))
      .catch((e) => console.warn("[keep-alive] ping falló:", e.message));
  }, 10 * 60 * 1000);
});
