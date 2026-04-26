import { buildAuthHeaderValue, config } from "./config.js";

function ensureLeadingSlash(path) {
  if (!path) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId)
  };
}

export class BukClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.baseUrl;
    this.timeoutMs = options.timeoutMs || config.timeoutMs;
    this.routePrefix = options.routePrefix ?? config.routePrefix;
    this.starterHealthPath = options.starterHealthPath || config.starterHealthPath;
  }

  withPrefix(path, { skipPrefix = false } = {}) {
    const normalized = ensureLeadingSlash(path);
    if (skipPrefix || !this.routePrefix) {
      return normalized;
    }
    return `${this.routePrefix}${normalized}`;
  }

  async request(method, path, { query, body, signal, skipPrefix = false } = {}) {
    const url = new URL(this.withPrefix(path, { skipPrefix }), this.baseUrl);

    if (query && typeof query === "object") {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      });
    }

    const timeout = withTimeout(signal, this.timeoutMs);

    const headers = {
      "Content-Type": "application/json",
      [config.authHeader]: buildAuthHeaderValue()
    };

    if (config.sendLegacyAuthHeader && config.legacyAuthHeader) {
      headers[config.legacyAuthHeader] = config.apiToken;
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeout.signal
      });

      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        const message = typeof payload === "string" ? payload : JSON.stringify(payload);
        throw new Error(`BUK respondio ${response.status}: ${message}`);
      }

      return payload;
    } finally {
      timeout.clear();
    }
  }

  get(path, query, options = {}) {
    return this.request("GET", path, { query, ...options });
  }

  post(path, body, options = {}) {
    return this.request("POST", path, { body, ...options });
  }

  pingStarter() {
    return this.get(this.starterHealthPath, undefined, { skipPrefix: true }).catch(() =>
      this.get("/", undefined, { skipPrefix: true })
    );
  }
}
