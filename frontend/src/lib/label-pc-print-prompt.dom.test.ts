// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupPcPrintPrompt } from "./label-pc-print-prompt";

type Pending = { id: number; spool_id: number; preset_id: number | null };
let pending: Pending | null;
let claims: string[];
let claimStatus: number;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <div id="pc-print-prompt" class="fm-alert-info pc-print-prompt hidden" role="status" aria-live="polite">
      <span class="pc-print-prompt-icon" aria-hidden="true"><svg><use href="/icons.svg#icon-printers"></use></svg></span>
      <div class="pc-print-prompt-copy"><strong class="pc-print-prompt-title"></strong><p class="pc-print-prompt-message"></p></div>
      <button type="button" class="fm-btn fm-btn-primary pc-print-prompt-open"></button>
      <button type="button" class="fm-btn fm-btn-outline pc-print-prompt-close"></button>
    </div>`;
  pending = null;
  claims = [];
  claimStatus = 204;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/claim")) {
      claims.push(url);
      return new Response(null, { status: claimStatus });
    }
    return new Response(JSON.stringify(pending));
  });
});

afterEach(() => {
  window.dispatchEvent(
    Object.assign(new Event("pagehide"), { persisted: false }),
  );
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("renders a themed print request card with a printer icon and clear copy", async () => {
  pending = { id: 1, spool_id: 73, preset_id: null };

  setupPcPrintPrompt();
  await vi.advanceTimersByTimeAsync(0);

  const prompt = document.querySelector<HTMLElement>(".pc-print-prompt")!;
  expect(prompt.classList.contains("hidden")).toBe(false);
  expect(prompt.getAttribute("role")).toBe("status");
  expect(prompt.getAttribute("aria-live")).toBe("polite");
  expect(
    prompt.querySelector(".pc-print-prompt-icon use")?.getAttribute("href"),
  ).toBe("/icons.svg#icon-printers");
  expect(
    prompt.querySelector(".pc-print-prompt-title")?.textContent,
  ).toBeTruthy();
  expect(
    prompt.querySelector(".pc-print-prompt-message")?.textContent,
  ).toContain("73");
  expect(prompt.querySelector<HTMLButtonElement>("button")?.type).toBe(
    "button",
  );
});

it("dismisses and consumes a print request from the close button", async () => {
  pending = { id: 7, spool_id: 73, preset_id: null };
  setupPcPrintPrompt();
  await vi.advanceTimersByTimeAsync(0);

  document.querySelector<HTMLButtonElement>(".pc-print-prompt-close")!.click();
  await vi.advanceTimersByTimeAsync(0);

  expect(claims).toEqual(["/api/v1/labels/print-requests/7/claim"]);
  expect(
    document.querySelector(".pc-print-prompt")?.classList.contains("hidden"),
  ).toBe(true);
});

it("keeps a dismissed request hidden when claiming it fails", async () => {
  pending = { id: 8, spool_id: 73, preset_id: null };
  claimStatus = 503;
  setupPcPrintPrompt();
  await vi.advanceTimersByTimeAsync(0);

  document.querySelector<HTMLButtonElement>(".pc-print-prompt-close")!.click();
  await vi.advanceTimersByTimeAsync(3000);

  expect(claims).toEqual(["/api/v1/labels/print-requests/8/claim"]);
  expect(
    document.querySelector(".pc-print-prompt")?.classList.contains("hidden"),
  ).toBe(true);
});

it("opens the latest spool and preset when a legacy server reuses a request ID", async () => {
  pending = { id: 1, spool_id: 17, preset_id: 4 };
  setupPcPrintPrompt();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "17",
  );

  const button = document.querySelector<HTMLButtonElement>(
    '[role="status"] button',
  )!;
  button.focus();
  pending = { id: 1, spool_id: 28, preset_id: 9 };
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "28",
  );
  expect(document.activeElement).toBe(button);
  const printWindow = { location: { href: "about:blank" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(printWindow as unknown as Window);
  document.querySelector<HTMLButtonElement>('[role="status"] button')!.click();
  await vi.advanceTimersByTimeAsync(0);

  expect(claims).toEqual(["/api/v1/labels/print-requests/1/claim"]);
  expect(printWindow.location.href).toBe(
    "/spools/28/print?scale_print=1&preset_id=9",
  );
  expect(
    document.querySelector('[role="status"]')?.classList.contains("hidden"),
  ).toBe(true);
});

it("continues polling after a back-forward cache round trip and stops on unload", async () => {
  setupPcPrintPrompt();
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(
    Object.assign(new Event("pagehide"), { persisted: true }),
  );
  window.dispatchEvent(
    Object.assign(new Event("pageshow"), { persisted: true }),
  );
  pending = { id: 2, spool_id: 31, preset_id: null };
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "31",
  );

  window.dispatchEvent(
    Object.assign(new Event("pagehide"), { persisted: false }),
  );
  pending = { id: 3, spool_id: 42, preset_id: null };
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "31",
  );
});
