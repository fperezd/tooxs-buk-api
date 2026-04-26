import crypto from "node:crypto";
import express from "express";
import { BukConversationalAgent } from "./agent.js";
import { config } from "./config.js";

const app = express();
app.use(express.json());

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

  // Comparación en tiempo constante para evitar timing attacks
  const providedBuf = Buffer.from(provided ?? "", "utf8");
  const expectedBuf = Buffer.from(serverApiKey, "utf8");
  const valid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!valid) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }

  next();
}

// ── Health check (público, sin auth) ────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "Ok!", mode: config.mode });
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
const server = app.listen(PORT, () => {
  console.log(`Servidor BUK API escuchando en puerto ${PORT} (modo: ${config.mode})`);

  // Keep-alive: ping propio cada 10 minutos para evitar que Render lo duerma.
  // Solo se activa si SELF_URL está explícitamente configurado (entorno de producción).
  const selfUrl = process.env.SELF_URL;
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/health`)
        .then(() => console.log("[keep-alive] ping ok"))
        .catch((e) => console.warn("[keep-alive] ping falló:", e.message));
    }, 10 * 60 * 1000);
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`${signal} recibido. Cerrando servidor...`);
  server.close(() => {
    console.log("Servidor cerrado.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
