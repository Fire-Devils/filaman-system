import { t } from "./i18n";
import { api } from "./api";

/* Print requests stay in the database so every backend worker can see them. */
export function setupPcPrintPrompt() {
  let checking = false;
  let dismissed: string | null = null;
  const banner = document.getElementById("pc-print-prompt")!;
  const title = banner.querySelector<HTMLElement>(".pc-print-prompt-title")!;
  const message = banner.querySelector<HTMLElement>(
    ".pc-print-prompt-message",
  )!;
  const openButton = banner.querySelector<HTMLButtonElement>(
    ".pc-print-prompt-open",
  )!;
  const closeButton = banner.querySelector<HTMLButtonElement>(
    ".pc-print-prompt-close",
  )!;
  title.textContent = t("labelPrint.pcPrintTitle");
  openButton.textContent = t("labelPrint.openPcPrint");
  closeButton.setAttribute("aria-label", t("common.close"));

  function claim(requestId: number) {
    return api.post<void>(`/labels/print-requests/${requestId}/claim`);
  }

  async function check() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const pending = await api.get<{
        id: number;
        preset_id: number | null;
      } & ({ spool_id: number } | { filament_id: number }) | null>("/labels/print-requests/pending");
      if (!pending) {
        banner.classList.add("hidden");
        return;
      }
      const isFilament = "filament_id" in pending;
      const entityPath = isFilament ? "filaments" : "spools";
      const entityId = isFilament ? pending.filament_id : pending.spool_id;
      const fingerprint = `${pending.id}:${entityPath}:${entityId}:${pending.preset_id ?? ""}`;
      if (fingerprint === dismissed) {
        banner.classList.add("hidden");
        // A failed dismissal must not leave the oldest request blocking the queue.
        await claim(pending.id).catch(() => {});
        return;
      }
      message.textContent = t(isFilament ? "labelPrint.pcPrintFilamentPrompt" : "labelPrint.pcPrintPrompt", {
        id: entityId,
      });
      closeButton.onclick = () => {
        dismissed = fingerprint;
        banner.classList.add("hidden");
        void claim(pending.id).catch(() => {});
      };
      openButton.onclick = () => {
        const printWindow = window.open("about:blank", "_blank");
        if (!printWindow) return;
        void claim(pending.id)
          .then(() => {
            const preset = pending.preset_id
              ? `&preset_id=${pending.preset_id}`
              : "";
            printWindow.location.href = `/${entityPath}/${entityId}/print?scale_print=1${preset}`;
          })
          .catch(() => printWindow.close())
          .finally(() => banner.classList.add("hidden"));
      };
      banner.classList.remove("hidden");
    } catch {
      /* Keep the tab usable when the server is unavailable. */
    } finally {
      checking = false;
    }
  }

  void check();
  const timer = window.setInterval(() => {
    void check();
  }, 3000);
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) window.clearInterval(timer);
  });
}
