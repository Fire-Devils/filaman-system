import { toColorSwatchBackground } from "./colors";
import { escapeHtml } from "./extra-fields";
import type {
  SpoolmanExtraFieldPreview,
  SpoolmanImportResult,
  SpoolmanPreviewResponse,
} from "./spoolman-api";
import { SpoolmanApiError } from "./spoolman-api";
import type { SpoolmanControllerDeps } from "./spoolman-controller-types";
import {
  buildImportExtraFieldResultSummary,
  buildImportFieldActions,
  escapeHtmlAttribute,
  resolveImportDefinitionAvailability,
  resolveImportModeAvailability,
  type ImportDefinitionAvailability,
  type ImportStorageAction,
  type ImportStorageMode,
} from "./spoolman-extra-field-ui";

function value(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function objectValue(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const candidate = record[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function display(value: unknown, fallback = "-"): string {
  return escapeHtml(value == null || value === "" ? fallback : String(value));
}

function morePreviewRow(
  total: number,
  columns: number,
  t: (key: string) => string,
): string {
  if (total <= 20) return "";
  const label = t("spoolman.andMore").replace("{count}", String(total - 20));
  return `<tr><td colspan="${columns}" style="text-align:center;color:var(--text-muted);font-style:italic;">... ${escapeHtml(label)}</td></tr>`;
}

export function renderVendorPreview(
  vendors: Record<string, unknown>[],
  t: (key: string) => string,
): string {
  if (!vendors.length) return "";
  const rows = vendors
    .slice(0, 20)
    .map(
      (vendor) => `<tr>
        <td>${display(value(vendor, "name"))}</td>
        <td style="color:var(--text-muted);font-size:0.85rem;">${display(value(vendor, "url"))}</td>
      </tr>`,
    )
    .join("");
  return `<details style="margin-top:12px;">
    <summary style="cursor:pointer;font-weight:600;font-size:0.9rem;color:var(--accent);">${escapeHtml(t("spoolman.previewVendors"))} (${vendors.length})</summary>
    <table class="fm-table" style="margin-top:8px;"><thead style="background:var(--bg-soft);"><tr><th>${escapeHtml(t("common.name"))}</th><th>URL</th></tr></thead><tbody>${rows}${morePreviewRow(vendors.length, 2, t)}</tbody></table>
  </details>`;
}

export function renderFilamentPreview(
  filaments: Record<string, unknown>[],
  t: (key: string) => string,
): string {
  if (!filaments.length) return "";
  const rows = filaments
    .slice(0, 20)
    .map((filament) => {
      const color = value(filament, "color_hex");
      const swatch =
        typeof color === "string" && color
          ? `<span style="display:inline-block;width:16px;height:16px;border-radius:3px;background:${toColorSwatchBackground(color)};border:1px solid var(--border);vertical-align:middle;margin-right:6px;"></span>`
          : "";
      return `<tr>
        <td>${swatch}${display(value(filament, "name"))}</td>
        <td>${display(value(filament, "material"))}</td>
        <td>${display(objectValue(filament, "vendor")?.name)}</td>
      </tr>`;
    })
    .join("");
  return `<details style="margin-top:12px;">
    <summary style="cursor:pointer;font-weight:600;font-size:0.9rem;color:var(--accent);">${escapeHtml(t("spoolman.previewFilaments"))} (${filaments.length})</summary>
    <table class="fm-table" style="margin-top:8px;"><thead style="background:var(--bg-soft);"><tr><th>${escapeHtml(t("common.name"))}</th><th>${escapeHtml(t("filaments.type"))}</th><th>${escapeHtml(t("filaments.manufacturer"))}</th></tr></thead><tbody>${rows}${morePreviewRow(filaments.length, 3, t)}</tbody></table>
  </details>`;
}

export function renderSpoolPreview(
  spools: Record<string, unknown>[],
  t: (key: string) => string,
): string {
  if (!spools.length) return "";
  const rows = spools
    .slice(0, 20)
    .map(
      (spool) => `<tr>
        <td>#${display(value(spool, "id"))}</td>
        <td>${display(objectValue(spool, "filament")?.name)}</td>
        <td>${value(spool, "remaining_weight") == null ? "-" : `${display(value(spool, "remaining_weight"))}g`}</td>
        <td>${display(objectValue(spool, "location")?.name)}</td>
      </tr>`,
    )
    .join("");
  return `<details style="margin-top:12px;">
    <summary style="cursor:pointer;font-weight:600;font-size:0.9rem;color:var(--accent);">${escapeHtml(t("spoolman.previewSpools"))} (${spools.length})</summary>
    <table class="fm-table" style="margin-top:8px;"><thead style="background:var(--bg-soft);"><tr><th>ID</th><th>${escapeHtml(t("spools.filament"))}</th><th>${escapeHtml(t("spools.remaining"))}</th><th>${escapeHtml(t("spools.location"))}</th></tr></thead><tbody>${rows}${morePreviewRow(spools.length, 4, t)}</tbody></table>
  </details>`;
}

export function renderExtraFieldPreview(
  fields: SpoolmanExtraFieldPreview[],
  availability: ImportDefinitionAvailability,
  t: (key: string) => string,
): string {
  if (!availability.typedDefinitionsAvailable) {
    return `<div class="fm-card" style="margin-top:12px;padding:14px;border-color:var(--accent-3);">
      <strong>${escapeHtml(t("spoolman.extraFields"))}</strong>
      <p style="color:var(--text-muted);font-size:0.85rem;line-height:1.5;margin:8px 0 0;">${escapeHtml(t("spoolman.extraFieldDefinitionsUnavailable"))}</p>
    </div>`;
  }
  const missingTargetNotice = availability.missingTargets.length
    ? `<p style="color:var(--text-muted);font-size:0.85rem;line-height:1.5;margin:8px 0 0;">${escapeHtml(
        t("spoolman.extraFieldDefinitionsPartial").replace(
          "{targets}",
          availability.missingTargets
            .map((target) =>
              t(target === "filament" ? "filaments.title" : "spools.title"),
            )
            .join(", "),
        ),
      )}</p>`
    : "";
  if (!fields.length) {
    return missingTargetNotice
      ? `<div class="fm-card" style="margin-top:12px;padding:14px;border-color:var(--accent-3);"><strong>${escapeHtml(t("spoolman.extraFields"))}</strong>${missingTargetNotice}</div>`
      : "";
  }
  const counts = fields.reduce<Record<string, number>>((all, field) => {
    all[field.status] = (all[field.status] ?? 0) + 1;
    return all;
  }, {});
  const rows = fields
    .map((field) => {
      const supportsTyped = ["filament", "spool"].includes(field.target_type);
      const systemUnavailable =
        ["conflict", "unsupported"].includes(field.status) ||
        Boolean(field.system_conflict);
      const localUnavailable = ["reuse", "conflict", "unsupported"].includes(
        field.status,
      );
      const retainedConflict = field.system_conflict
        ? `<br><span style="color:var(--error-text);font-size:0.78rem;">${escapeHtml(t("spoolman.extraFieldRetainedConflict").replace("{count}", String(field.system_conflict.count)))}</span>`
        : "";
      return `<tr>
        <td><strong>${display(field.target_type)}.${display(field.key, "")}</strong><br><span style="color:var(--text-muted);font-size:0.78rem;">${display(field.label ?? field.reason, "")}</span>${retainedConflict}</td>
        <td>${display(field.field_type ?? field.status)}</td>
        <td>${
          supportsTyped
            ? `<select class="fm-select import-field-action" data-target="${escapeHtmlAttribute(field.target_type)}" data-key="${escapeHtmlAttribute(field.key)}">
                <option value="inherit">${escapeHtml(t("spoolman.extraFieldActionStep3Default"))}</option>
                <option value="system"${systemUnavailable ? " disabled" : ""}>${escapeHtml(t("spoolman.extraFieldActionSystem"))}</option>
                <option value="local"${localUnavailable ? " disabled" : ""}>${escapeHtml(t("spoolman.extraFieldActionLocal"))}</option>
                <option value="preserve">${escapeHtml(t("spoolman.extraFieldActionPreserve"))}</option>
                <option value="legacy">${escapeHtml(t("spoolman.extraFieldActionLegacy"))}</option>
              </select>`
            : escapeHtml(t("spoolman.extraFieldActionPreserve"))
        }</td>
      </tr>`;
    })
    .join("");
  return `<div class="fm-card" style="margin-top:12px;padding:14px;">
    <strong>${escapeHtml(t("spoolman.extraFields"))}</strong>
    ${missingTargetNotice}
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;color:var(--text-muted);font-size:0.85rem;">
      <span>${escapeHtml(t("spoolman.extraFieldsCreate"))}: ${counts.create ?? 0}</span>
      <span>${escapeHtml(t("spoolman.extraFieldsReuse"))}: ${counts.reuse ?? 0}</span>
      <span>${escapeHtml(t("spoolman.extraFieldsConflict"))}: ${counts.conflict ?? 0}</span>
      <span>${escapeHtml(t("spoolman.extraFieldsUnsupported"))}: ${counts.unsupported ?? 0}</span>
    </div>
    <p style="color:var(--text-muted);font-size:0.82rem;margin:10px 0 6px;">${escapeHtml(t("spoolman.extraFieldOverrideHint"))}</p>
    <div style="overflow-x:auto;"><table class="fm-table"><thead><tr><th>${escapeHtml(t("spoolman.repairField"))}</th><th>${escapeHtml(t("spoolman.repairType"))}</th><th>${escapeHtml(t("spoolman.extraFieldAction"))}</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function resultCard(
  label: string,
  created: number,
  skipped: number,
  t: (key: string) => string,
): string {
  return `<div style="background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;text-align:center;"><div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">${escapeHtml(label)}</div><div style="font-size:1.3rem;font-weight:700;color:var(--accent);">${created}</div><div style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(t("spoolman.created"))}</div>${skipped > 0 ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">${skipped} ${escapeHtml(t("spoolman.skipped"))}</div>` : ""}</div>`;
}

function resultMetricCard(
  label: string,
  metrics: Array<{ count: number; label: string }>,
  color = "var(--accent)",
): string {
  return `<div style="background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;text-align:center;"><div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:8px;">${escapeHtml(label)}</div><div style="display:flex;justify-content:center;gap:24px;">${metrics.map((metric) => `<div><div style="font-size:1.3rem;font-weight:700;color:${color};">${metric.count}</div><div style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(metric.label)}</div></div>`).join("")}</div></div>`;
}

export function renderImportResult(
  result: SpoolmanImportResult,
  t: (key: string) => string,
): string {
  const hasErrors = result.errors.length > 0;
  const summary = buildImportExtraFieldResultSummary(result);
  const cards = [
    resultCard(
      t("manufacturers.title"),
      result.manufacturers_created,
      result.manufacturers_skipped,
      t,
    ),
    resultCard(
      t("locations.title"),
      result.locations_created,
      result.locations_skipped,
      t,
    ),
    resultCard(
      t("filaments.colors"),
      result.colors_created,
      result.colors_skipped,
      t,
    ),
    resultCard(
      t("filaments.title"),
      result.filaments_created,
      result.filaments_skipped,
      t,
    ),
    resultCard(
      t("spools.title"),
      result.spools_created,
      result.spools_skipped,
      t,
    ),
  ].join("");
  const richCards: string[] = [];
  if (summary.systemCreated || summary.systemReused) {
    richCards.push(
      resultMetricCard(t("spoolman.extraFieldSystemDefinitions"), [
        { count: summary.systemCreated, label: t("spoolman.created") },
        { count: summary.systemReused, label: t("spoolman.reused") },
      ]),
    );
  }
  if (summary.localCreated) {
    richCards.push(
      resultMetricCard(t("spoolman.extraFieldLocalDefinitions"), [
        { count: summary.localCreated, label: t("spoolman.created") },
      ]),
    );
  }
  if (summary.valuesConverted || summary.valuesPreserved) {
    richCards.push(
      resultMetricCard(t("spoolman.extraFieldValues"), [
        { count: summary.valuesConverted, label: t("spoolman.converted") },
        { count: summary.valuesPreserved, label: t("spoolman.preserved") },
      ]),
    );
  }
  if (summary.conflicts) {
    richCards.push(
      resultMetricCard(
        t("spoolman.extraFieldConflicts"),
        [{ count: summary.conflicts, label: t("spoolman.preserved") }],
        "var(--error-text)",
      ),
    );
  }
  const rich = summary.hasActivity
    ? `<h4 style="font-size:0.9rem;font-weight:600;margin:18px 0 10px;">${escapeHtml(t("spoolman.extraFieldResults"))}</h4><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">${richCards.join("")}</div>`
    : "";
  const warnings = result.warnings.length
    ? `<details style="margin-top:16px;"><summary style="cursor:pointer;font-weight:600;font-size:0.9rem;color:var(--text-muted);">${escapeHtml(t("spoolman.warnings"))} (${result.warnings.length})</summary><ul style="margin-top:8px;padding-left:20px;font-size:0.85rem;color:var(--text-muted);">${result.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
    : "";
  const errors = result.errors.length
    ? `<details style="margin-top:12px;" open><summary style="cursor:pointer;font-weight:600;font-size:0.9rem;color:var(--error-text);">${escapeHtml(t("spoolman.errors"))} (${result.errors.length})</summary><ul style="margin-top:8px;padding-left:20px;font-size:0.85rem;color:var(--error-text);">${result.errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
    : "";
  return `<div style="padding:16px;border-radius:var(--radius-sm);background:var(--bg-soft);border:1px solid ${hasErrors ? "var(--error-text)" : "var(--accent-2)"};"><h3 style="font-size:1rem;font-weight:600;margin:0 0 12px;">${escapeHtml(t("spoolman.importResults"))}</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">${cards}</div>${rich}${warnings}${errors}<p style="margin:16px 0 0;color:var(--text-muted);font-size:0.82rem;line-height:1.5;">${escapeHtml(t("spoolman.importAgainHint"))}</p></div>`;
}

export function renderTransparencyRepairResult(
  result: SpoolmanImportResult,
  t: (key: string) => string,
): string {
  const repaired = Number(result.color_assignments_repaired) || 0;
  const repairedLabel = repaired
    ? t("spoolman.colorAssignmentsRepaired").replace(
        "{count}",
        String(repaired),
      )
    : t("spoolman.repairTransparencyNoChanges");
  const colorLabel = t("spoolman.repairTransparencyColors")
    .replace("{created}", String(result.colors_created || 0))
    .replace("{reused}", String(result.colors_skipped || 0));
  return `<div style="padding:16px;border-radius:var(--radius-sm);background:var(--bg-soft);border:1px solid var(--accent-2);"><h3 style="font-size:1rem;font-weight:600;margin:0 0 8px;">${escapeHtml(t("spoolman.repairTransparencyResults"))}</h3><p style="margin:0;color:var(--accent-2);">${escapeHtml(repairedLabel)}</p><p style="margin:6px 0 0;color:var(--text-muted);font-size:0.85rem;">${escapeHtml(colorLabel)}</p></div>`;
}

function errorMessage(error: unknown, deps: SpoolmanControllerDeps): string {
  if (
    error instanceof SpoolmanApiError &&
    error.code === "spoolman_import_in_progress"
  ) {
    return deps.t("spoolman.importInProgress");
  }
  return error instanceof Error ? error.message : String(error);
}

function enableStep(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.style.opacity = "1";
  element.style.pointerEvents = "auto";
}

function disableStep(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.style.opacity = "0.5";
  element.style.pointerEvents = "none";
}

export function initSpoolmanImportController(deps: SpoolmanControllerDeps): {
  reset(): void;
} {
  let connectedUrl = "";
  let previewData: SpoolmanPreviewResponse | null = null;
  let transparencyCandidates = 0;
  let transparencyDigest = "";
  let actionRunning = false;
  let revision = 0;

  const urlInput = document.querySelector<HTMLInputElement>("#spoolman-url");
  const testButton = document.querySelector<HTMLButtonElement>("#btn-test");
  const previewButton =
    document.querySelector<HTMLButtonElement>("#btn-preview");
  const importButton = document.querySelector<HTMLButtonElement>("#btn-import");
  const transparencyButton = document.querySelector<HTMLButtonElement>(
    "#btn-repair-transparency",
  );
  if (
    !urlInput ||
    !testButton ||
    !previewButton ||
    !importButton ||
    !transparencyButton
  ) {
    return { reset: () => undefined };
  }

  const result = (id: string) => document.getElementById(id);
  const renderError = (id: string, error: unknown) => {
    const host = result(id);
    if (!host) return;
    host.style.display = "block";
    host.innerHTML = `<div class="fm-alert-error">${escapeHtml(errorMessage(error, deps))}</div>`;
  };
  const updateButtons = () => {
    importButton.disabled =
      actionRunning || !previewData?.extra_field_fingerprint;
    transparencyButton.disabled = actionRunning || transparencyCandidates === 0;
  };
  const setTransparencyAction = (count: number, digest: string) => {
    transparencyCandidates = Math.max(0, Number(count) || 0);
    transparencyDigest = transparencyCandidates ? digest : "";
    transparencyButton.classList.toggle("hidden", !transparencyCandidates);
    result("transparency-repair-note")?.classList.toggle(
      "hidden",
      !transparencyCandidates,
    );
    const countHost = result("transparency-repair-count");
    if (countHost) countHost.textContent = String(transparencyCandidates || "");
    updateButtons();
  };
  const resetImportCompletionState = () => {
    const controls = result("import-controls");
    const progress = result("import-progress");
    const output = result("import-result");
    if (controls) controls.style.display = "block";
    if (progress) progress.style.display = "none";
    if (output) output.style.display = "none";
  };
  const finishImportUi = () => {
    previewData = null;
    setTransparencyAction(0, "");
    const previewHost = result("preview-result");
    const controls = result("import-controls");
    const progress = result("import-progress");
    if (previewHost) {
      previewHost.style.display = "none";
      previewHost.replaceChildren();
    }
    if (controls) controls.style.display = "none";
    if (progress) progress.style.display = "none";
    previewButton.textContent = deps.t("spoolman.loadNewPreview");
    updateButtons();
  };

  const reset = (): void => {
    revision += 1;
    connectedUrl = "";
    previewData = null;
    setTransparencyAction(0, "");
    resetImportCompletionState();
    disableStep("step-preview");
    disableStep("step-import");
    const previewHost = result("preview-result");
    if (previewHost) previewHost.replaceChildren();
    updateButtons();
  };

  urlInput.addEventListener("input", reset);
  reset();

  testButton.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      renderError("connection-result", deps.t("spoolman.urlRequired"));
      return;
    }
    const requestRevision = ++revision;
    testButton.disabled = true;
    try {
      const response = await deps.api.testConnection(url, deps.signal());
      if (requestRevision !== revision) return;
      connectedUrl = url;
      previewData = null;
      enableStep("step-preview");
      disableStep("step-import");
      const host = result("connection-result");
      if (host) {
        host.style.display = "block";
        host.innerHTML = `<div class="fm-alert-success"><strong>${escapeHtml(deps.t("spoolman.connectionSuccess"))}</strong><div>URL: ${escapeHtml(response.url)}</div></div>`;
      }
    } catch (error) {
      if (requestRevision !== revision) return;
      connectedUrl = "";
      disableStep("step-preview");
      disableStep("step-import");
      renderError("connection-result", error);
    } finally {
      testButton.disabled = false;
    }
  });

  previewButton.addEventListener("click", async () => {
    if (!connectedUrl) return;
    const requestRevision = ++revision;
    previewButton.disabled = true;
    try {
      const response = await deps.api.loadPreview(
        { url: connectedUrl, include_transparency_repairs: true },
        deps.signal(),
      );
      if (requestRevision !== revision) return;
      previewData = response;
      const definitionAvailability = resolveImportDefinitionAvailability(
        response.extra_field_targets,
      );
      const modeSelect =
        document.querySelector<HTMLSelectElement>("#extra-field-mode");
      if (modeSelect) {
        const availability = resolveImportModeAvailability(
          modeSelect.value as ImportStorageMode,
          definitionAvailability.typedDefinitionsAvailable,
        );
        modeSelect
          .querySelectorAll<HTMLOptionElement>(
            'option[value="system"], option[value="local"]',
          )
          .forEach((option) => {
            option.disabled = availability.typedModesDisabled;
          });
        modeSelect.value = availability.mode;
      }
      const host = result("preview-result");
      if (host) {
        host.style.display = "block";
        host.innerHTML = `<div class="fm-card"><strong>${escapeHtml(deps.t("spoolman.stepPreview"))}</strong><p>${response.summary.vendors} / ${response.summary.filaments} / ${response.summary.spools}</p></div>
          ${renderVendorPreview(response.vendors, deps.t)}
          ${renderFilamentPreview(response.filaments, deps.t)}
          ${renderSpoolPreview(response.spools, deps.t)}
          ${renderExtraFieldPreview(response.extra_fields ?? [], definitionAvailability, deps.t)}`;
      }
      setTransparencyAction(
        response.transparency_repair_candidates ?? 0,
        response.transparency_repair_plan_digest ?? "",
      );
      if (response.extra_field_fingerprint) enableStep("step-import");
      else disableStep("step-import");
      resetImportCompletionState();
      updateButtons();
    } catch (error) {
      if (requestRevision !== revision) return;
      previewData = null;
      disableStep("step-import");
      setTransparencyAction(0, "");
      renderError("preview-result", error);
    } finally {
      previewButton.disabled = false;
    }
  });

  importButton.addEventListener("click", async () => {
    if (!previewData || actionRunning) return;
    const confirmed = await deps.confirm(deps.t("spoolman.confirmImport"), {
      title: deps.t("spoolman.startImport"),
      okLabel: deps.t("spoolman.startImport"),
      isDanger: false,
    });
    if (!confirmed || actionRunning) return;
    const fingerprint = previewData.extra_field_fingerprint;
    if (!fingerprint) return;
    actionRunning = true;
    updateButtons();
    try {
      const mode =
        document.querySelector<HTMLSelectElement>("#extra-field-mode")?.value ??
        "legacy";
      const fieldActions = buildImportFieldActions(
        Array.from(
          document.querySelectorAll<HTMLSelectElement>(".import-field-action"),
        ).map((select) => ({
          targetType: select.dataset.target,
          key: select.dataset.key,
          action: select.value as ImportStorageAction,
        })),
      );
      const imported = await deps.api.executeImport(
        {
          url: connectedUrl,
          extra_field_fingerprint: fingerprint,
          extra_field_mode: mode as ImportStorageMode,
          field_actions: fieldActions.map((item) => ({
            ...item,
            action: item.action as Exclude<ImportStorageAction, "inherit">,
          })),
        },
        deps.signal(),
      );
      const host = result("import-result");
      if (host) {
        host.style.display = "block";
        host.innerHTML = renderImportResult(imported, deps.t);
      }
      finishImportUi();
    } catch (error) {
      renderError("import-result", error);
    } finally {
      actionRunning = false;
      updateButtons();
    }
  });

  transparencyButton.addEventListener("click", async () => {
    if (!connectedUrl || !transparencyDigest || actionRunning) return;
    const confirmed = await deps.confirm(
      deps.t("spoolman.confirmRepairTransparency"),
      {
        title: deps.t("spoolman.repairTransparency"),
        okLabel: deps.t("spoolman.repairTransparency"),
        isDanger: false,
      },
    );
    if (!confirmed || actionRunning) return;
    actionRunning = true;
    updateButtons();
    try {
      const repaired = await deps.api.repairTransparency(
        { url: connectedUrl, plan_digest: transparencyDigest },
        deps.signal(),
      );
      setTransparencyAction(0, "");
      const host = result("import-result");
      if (host) {
        host.style.display = "block";
        host.innerHTML = renderTransparencyRepairResult(repaired, deps.t);
      }
    } catch (error) {
      renderError("import-result", error);
    } finally {
      actionRunning = false;
      updateButtons();
    }
  });

  return { reset };
}
