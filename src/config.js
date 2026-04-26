import dotenv from "dotenv";

dotenv.config();

function optional(name) {
  const value = process.env[name];
  if (!value) {
    return "";
  }
  return value.trim();
}

function numberWithDefault(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`La variable ${name} debe ser un numero positivo.`);
  }
  return parsed;
}

function normalizePathPrefix(prefix) {
  if (!prefix) {
    return "";
  }

  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

const starterBaseUrl = optional("BUK_STARTER_BASE_URL");
const directBaseUrl = optional("BUK_BASE_URL");
const baseUrl = (starterBaseUrl || directBaseUrl).replace(/\/+$/, "");

if (!baseUrl) {
  throw new Error("Falta BUK_STARTER_BASE_URL o BUK_BASE_URL en el entorno.");
}

const starterToken = optional("BUK_STARTER_API_TOKEN");
const directToken = optional("BUK_API_TOKEN");
const apiToken = starterToken || directToken;

if (!apiToken) {
  throw new Error("Falta BUK_STARTER_API_TOKEN o BUK_API_TOKEN en el entorno.");
}

const authHeader =
  optional("BUK_STARTER_AUTH_HEADER") ||
  optional("BUK_AUTH_HEADER") ||
  "Authorization";

const authScheme =
  optional("BUK_STARTER_AUTH_SCHEME") ||
  optional("BUK_AUTH_SCHEME") ||
  "Bearer";

export const config = {
  mode: starterBaseUrl ? "starter" : "direct",
  baseUrl,
  apiToken,
  authHeader,
  authScheme,
  legacyAuthHeader: optional("BUK_STARTER_LEGACY_AUTH_HEADER") || "auth_token",
  sendLegacyAuthHeader:
    (optional("BUK_STARTER_SEND_LEGACY_AUTH_HEADER") || "true").toLowerCase() !== "false",
  routePrefix: normalizePathPrefix(optional("BUK_STARTER_ROUTE_PREFIX")),
  timeoutMs: numberWithDefault("BUK_TIMEOUT_MS", 15000),
  starterHealthPath: optional("BUK_STARTER_HEALTH_PATH") || "/health"
};

export function buildAuthHeaderValue() {
  if (!config.authScheme) {
    return config.apiToken;
  }
  return `${config.authScheme} ${config.apiToken}`;
}
