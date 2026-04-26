import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ── requireApiKey logic (extracted for unit testing) ─────────────────────────
function createRequireApiKey(serverApiKey) {
  return function requireApiKey(provided) {
    if (!serverApiKey) return { status: 503 };

    const providedBuf = Buffer.from(provided ?? "", "utf8");
    const expectedBuf = Buffer.from(serverApiKey, "utf8");
    const valid =
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);

    return valid ? { status: 200 } : { status: 401 };
  };
}

describe("requireApiKey", () => {
  it("retorna 200 con clave correcta", () => {
    const check = createRequireApiKey("secret123");
    expect(check("secret123").status).toBe(200);
  });

  it("retorna 401 con clave incorrecta", () => {
    const check = createRequireApiKey("secret123");
    expect(check("wrongkey").status).toBe(401);
  });

  it("retorna 401 con clave vacía", () => {
    const check = createRequireApiKey("secret123");
    expect(check("").status).toBe(401);
    expect(check(undefined).status).toBe(401);
  });

  it("retorna 503 si SERVER_API_KEY no está configurada", () => {
    const check = createRequireApiKey(undefined);
    expect(check("anything").status).toBe(503);
  });

  it("retorna 401 con clave de diferente longitud (no timing leak)", () => {
    const check = createRequireApiKey("secret123");
    expect(check("secret").status).toBe(401);
    expect(check("secret123extra").status).toBe(401);
  });
});
