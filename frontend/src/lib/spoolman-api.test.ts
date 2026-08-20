import { describe, expect, it, vi } from "vitest";

import { createSpoolmanApi, SpoolmanApiError } from "./spoolman-api";

describe("Spoolman API client", () => {
  it("sends CSRF credentials and returns typed JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ status: "ok", url: "http://spoolman", info: {} }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const api = createSpoolmanApi({
      fetchImpl: fetchImpl as typeof fetch,
      csrfToken: () => "csrf",
    });

    const response = await api.testConnection("http://spoolman");

    expect(response.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/admin/system/spoolman-import/test-connection",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
        body: JSON.stringify({ url: "http://spoolman" }),
      }),
    );
  });

  it("throws the backend detail code and message", async () => {
    const api = createSpoolmanApi({
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            detail: { code: "preview_changed", message: "Reload" },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ) as typeof fetch,
      csrfToken: () => "csrf",
    });

    await expect(
      api.executeRepair({
        mode: "offline",
        preview_fingerprint: "a".repeat(64),
        approved_mappings: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "preview_changed",
      message: "Reload",
    } satisfies Partial<SpoolmanApiError>);
  });
});
