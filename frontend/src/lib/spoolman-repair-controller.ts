import { escapeHtml } from "./extra-fields";
import type {
  ApprovedRepairMappingRequest,
  RepairExamplePreviewResponse,
  RepairExecuteResponse,
  RepairMode,
  RepairPreviewResponse,
} from "./spoolman-api";
import { SpoolmanApiError } from "./spoolman-api";
import type { SpoolmanControllerDeps } from "./spoolman-controller-types";
import {
  RepairMappingValidationError,
  buildRepairMappingPayload,
  escapeHtmlAttribute,
  formatRepairExampleValue,
  parseRepairChoiceDetails,
  repairConfidenceReason,
  repairConfidenceTone,
  repairDetailsState,
  repairFieldTypes,
  repairMappingInteractionState,
  type RepairFieldType,
  type RepairMapping,
  type RepairMappingEdits,
  type RepairStorageAction,
} from "./spoolman-extra-field-ui";

function errorMessage(error: unknown, deps: SpoolmanControllerDeps): string {
  if (
    error instanceof SpoolmanApiError &&
    error.code === "spoolman_import_in_progress"
  ) {
    return deps.t("spoolman.importInProgress");
  }
  return error instanceof Error ? error.message : String(error);
}

function repairMode(): RepairMode {
  const selected = document.querySelector<HTMLInputElement>(
    'input[name="repair-mode"]:checked',
  )?.value;
  return selected === "server" ? "server" : "offline";
}

function mappingSamples(mapping: RepairMapping): unknown[] {
  const samples = mapping.samples;
  if (Array.isArray(samples) && samples.length) return samples.slice(0, 3);
  const examples = mapping.conversion_examples ?? [];
  return examples.map((example) => example.source).slice(0, 3);
}

function detailsValue(
  fieldType: RepairFieldType,
  kind: "unit" | "choices" | "none",
  raw: string,
): string {
  if (kind !== "choices") return raw;
  try {
    return JSON.stringify(parseRepairChoiceDetails(raw));
  } catch {
    return fieldType === "dropdown" || fieldType === "multiselect" ? raw : "";
  }
}

function typeLabel(
  fieldType: RepairFieldType,
  t: (key: string) => string,
): string {
  return t(`admin.fieldType_${fieldType}`);
}

function renderConfidence(
  mapping: RepairMapping,
  selectedType: RepairFieldType,
  t: (key: string) => string,
): string {
  const tone = repairConfidenceTone(
    selectedType === mapping.field_type ? mapping.confidence : "unresolved",
  );
  const reason = repairConfidenceReason(mapping, selectedType);
  const reasonKey = {
    source_definition: "spoolman.repairConfidenceReasonSourceDefinition",
    structured_values: "spoolman.repairConfidenceReasonStructuredValues",
    date_pattern: "spoolman.repairConfidenceReasonDatePattern",
    url_pattern: "spoolman.repairConfidenceReasonUrlPattern",
    majority_match: "spoolman.repairConfidenceReasonMajorityMatch",
    legacy_text: "spoolman.repairConfidenceReasonLegacyText",
    legacy_number: "spoolman.repairConfidenceReasonLegacyNumber",
    legacy_checkbox: "spoolman.repairConfidenceReasonLegacyCheckbox",
    legacy_scalar: "spoolman.repairConfidenceReasonLegacyScalar",
    fallback_text: "spoolman.repairConfidenceReasonFallbackText",
    mixed_text: "spoolman.repairConfidenceReasonMixedText",
    invalid_key: "spoolman.repairConfidenceReasonInvalidKey",
    mixed_values: "spoolman.repairConfidenceReasonMixedValues",
    manual: "spoolman.repairConfidenceManualHint",
    generic_high: "spoolman.repairConfidenceReasonGenericHigh",
    generic_medium: "spoolman.repairConfidenceReasonGenericMedium",
    generic_low: "spoolman.repairConfidenceReasonGenericLow",
    generic_unresolved: "spoolman.repairConfidenceReasonGenericUnresolved",
  }[reason];
  return `<div class="repair-confidence-content" data-tone="${escapeHtmlAttribute(tone)}">
    <strong>${escapeHtml(typeLabel(selectedType, t))}</strong>
    <span>${escapeHtml(t(reasonKey))}</span>
  </div>`;
}

function renderEvidenceRows(
  examples: Array<{ source: unknown; converted: unknown }>,
  fieldType: RepairFieldType,
  unit: string,
  t: (key: string) => string,
): string {
  const checked = t("spoolman.repairChecked");
  const unchecked = t("spoolman.repairUnchecked");
  return examples
    .map((example) => {
      const source = formatRepairExampleValue(
        example.source,
        fieldType,
        false,
        checked,
        unchecked,
      );
      const converted = formatRepairExampleValue(
        example.converted,
        fieldType,
        true,
        checked,
        unchecked,
        unit,
      );
      return `<div class="repair-example">
        <code title="${escapeHtmlAttribute(source)}">${escapeHtml(source)}</code>
        <span aria-hidden="true">→</span>
        <code title="${escapeHtmlAttribute(converted)}">${escapeHtml(converted)}</code>
      </div>`;
    })
    .join("");
}

function renderInitialEvidence(
  mapping: RepairMapping,
  t: (key: string) => string,
): string {
  const examples = mapping.conversion_examples ?? [];
  if (!examples.length) {
    const samples = mappingSamples(mapping)
      .map((sample) =>
        typeof sample === "string" ? sample : JSON.stringify(sample),
      )
      .join(", ");
    return samples
      ? `<div><strong>${escapeHtml(t("spoolman.repairSamples"))}:</strong> ${escapeHtml(samples)}</div>`
      : "";
  }
  const unit = String(mapping.config?.unit ?? "");
  return `<div class="repair-conversion-preview"><div class="repair-example-grid">${renderEvidenceRows(examples, mapping.field_type, unit, t)}</div></div>`;
}

function renderMappingCard(
  mapping: RepairMapping,
  index: number,
  t: (key: string) => string,
): string {
  const interaction = repairMappingInteractionState(mapping);
  const details = repairDetailsState(mapping, mapping.field_type);
  const options = repairFieldTypes
    .map(
      (fieldType) =>
        `<option value="${fieldType}"${fieldType === mapping.field_type ? " selected" : ""}>${escapeHtml(typeLabel(fieldType, t))}</option>`,
    )
    .join("");
  const systemUnavailable = Boolean(mapping.system_conflict);
  const retainedConflict = mapping.system_conflict
    ? `<div class="repair-retained-conflict">${escapeHtml(t("spoolman.extraFieldRetainedConflict").replace("{count}", String(mapping.system_conflict.count)))}</div>`
    : "";
  const noPromotable =
    mapping.status === "no_promotable"
      ? `<div class="repair-no-promotable">${escapeHtml(t("spoolman.repairNoPromotable"))}</div>`
      : "";
  const localUnavailable = Boolean(mapping.existing);
  const localSelected = systemUnavailable && !localUnavailable;
  return `<section class="repair-mapping-card" data-repair-index="${index}">
    <div class="repair-mapping-header">
      <div>
        <label class="repair-field-heading">
          <input type="checkbox" class="repair-approve"${interaction.approvable ? "" : " disabled"} aria-label="${escapeHtmlAttribute(t("spoolman.repairApprove"))}" />
          <span><span class="repair-section-label">${escapeHtml(t("spoolman.repairApprove"))}</span><strong class="repair-field-key">${escapeHtml(mapping.target_type)}.${escapeHtml(mapping.key)}</strong></span>
        </label>
        ${retainedConflict}${noPromotable}
      </div>
      <div><span class="repair-section-label">${escapeHtml(t("spoolman.repairConfidence"))}</span><div class="repair-confidence-host">${renderConfidence(mapping, mapping.field_type, t)}</div></div>
    </div>
    <div class="repair-controls">
      <label class="repair-control"><span>${escapeHtml(t("admin.displayLabel"))}</span><input class="fm-input repair-label" value="${escapeHtmlAttribute(mapping.label || mapping.key)}"${interaction.editable ? "" : " disabled"} /></label>
      <label class="repair-control"><span>${escapeHtml(t("spoolman.repairType"))}</span><select class="fm-select repair-type" data-current-type="${escapeHtmlAttribute(mapping.field_type)}"${interaction.editable ? "" : " disabled"}>${options}</select></label>
      <label class="repair-control"><span>${escapeHtml(t("spoolman.repairDetails"))}</span><input class="fm-input repair-details" data-details-kind="${escapeHtmlAttribute(details.kind)}" data-details-edited="false" value="${escapeHtmlAttribute(detailsValue(mapping.field_type, details.kind, details.value))}" placeholder="${escapeHtmlAttribute(details.kind === "choices" ? t("spoolman.repairChoicesPlaceholder") : "")}"${!interaction.editable || details.disabled ? " disabled" : ""}${details.required ? " required" : ""} /></label>
      <label class="repair-control"><span>${escapeHtml(t("spoolman.extraFieldAction"))}</span><select class="fm-select repair-action"${interaction.editable ? "" : " disabled"}>
        <option value="system"${systemUnavailable ? " disabled" : ""}>${escapeHtml(t(mapping.existing ? "spoolman.extraFieldActionReuseSystem" : "spoolman.extraFieldActionSystem"))}</option>
        <option value="local"${localUnavailable ? " disabled" : ""}${localSelected ? " selected" : ""}>${escapeHtml(t("spoolman.extraFieldActionLocal"))}</option>
        <option value="preserve">${escapeHtml(t("spoolman.extraFieldActionPreserve"))}</option>
      </select></label>
    </div>
    <div class="repair-conversion-host">${renderInitialEvidence(mapping, t)}</div>
  </section>`;
}

function renderRepairPreview(
  preview: RepairPreviewResponse,
  t: (key: string) => string,
): string {
  const summary = preview.summary;
  const warnings = preview.warnings ?? [];
  const warningSection = warnings.length
    ? `<details class="fm-alert-warning repair-warning-section"><summary>${escapeHtml(t("spoolman.warnings"))} (${warnings.length})</summary><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>`
    : "";
  if (!summary.records_scanned && !preview.mappings.length) {
    const importedRecords = Number(summary.imported_records || 0);
    const message = importedRecords
      ? t("spoolman.repairAlreadyHandled").replace(
          "{count}",
          String(importedRecords),
        )
      : t("spoolman.repairNoImports");
    return `${warningSection}<div class="${importedRecords ? "fm-alert-success" : "fm-alert-info"}">${escapeHtml(message)}</div>`;
  }
  const cards = preview.mappings
    .map((mapping, index) => renderMappingCard(mapping, index, t))
    .join("");
  const metric = (label: string, value: number) =>
    `<div class="repair-metric"><div>${escapeHtml(label)}</div><strong>${value}</strong></div>`;
  return `${warningSection}<div class="repair-metrics">
      ${metric(t("spoolman.repairRecords"), summary.records_scanned)}
      ${metric(t("spoolman.repairFields"), summary.fields_found)}
      ${metric(t("spoolman.repairPromotable"), summary.promotable)}
      ${metric(t("spoolman.repairCollisions"), summary.collisions)}
      ${metric(t("spoolman.repairUnresolved"), summary.unresolved + summary.invalid)}
    </div>${cards ? `<div class="repair-mapping-list">${cards}</div>` : ""}`;
}

function mappingEditsFromRow(
  row: HTMLElement,
  source: RepairMapping,
): RepairMappingEdits {
  const details = row.querySelector<HTMLInputElement>(".repair-details");
  return {
    label:
      row.querySelector<HTMLInputElement>(".repair-label")?.value ?? source.key,
    fieldType: (row.querySelector<HTMLSelectElement>(".repair-type")?.value ??
      source.field_type) as RepairFieldType,
    details: details?.value ?? "",
    detailsEdited: details?.dataset.detailsEdited === "true",
    action: (row.querySelector<HTMLSelectElement>(".repair-action")?.value ??
      "system") as RepairStorageAction,
  };
}

function renderBackendEvidence(
  row: HTMLElement,
  fieldType: RepairFieldType,
  response: RepairExamplePreviewResponse,
  t: (key: string) => string,
): void {
  const host = row.querySelector<HTMLElement>(".repair-conversion-host");
  if (!host) return;
  const unit =
    row.querySelector<HTMLInputElement>(".repair-details")?.value ?? "";
  const rows = renderEvidenceRows(
    response.conversion_examples,
    fieldType,
    unit,
    t,
  );
  const invalid = response.invalid_sample_indexes.length;
  host.innerHTML = `<div class="repair-conversion-preview"><div class="repair-example-grid">${rows}</div>${invalid ? `<div class="fm-alert-warning">${invalid} ${escapeHtml(t("spoolman.repairValuesPreserved"))}</div>` : ""}</div>`;
}

function renderRepairSuccess(
  result: RepairExecuteResponse,
  approved: ApprovedRepairMappingRequest[],
  t: (key: string) => string,
): void {
  const output = document.getElementById("repair-result");
  if (!output) return;
  output.style.display = "block";
  output.innerHTML = `<div class="fm-alert-success"><strong>${escapeHtml(t("spoolman.repairComplete"))}</strong><div class="repair-result-metrics">
    <span>${escapeHtml(t("spoolman.repairDefinitionsCreated"))}: ${result.definitions_created}</span>
    <span>${escapeHtml(t("spoolman.repairLocalDefinitionsCreated"))}: ${result.local_definitions_created}</span>
    <span>${escapeHtml(t("spoolman.repairRecordsUpdated"))}: ${result.records_updated}</span>
    <span>${escapeHtml(t("spoolman.repairValuesPromoted"))}: ${result.values_promoted}</span>
    <span>${escapeHtml(t("spoolman.repairValuesPreserved"))}: ${result.values_preserved}</span>
  </div><button id="btn-download-repair" class="fm-btn fm-btn-outline">${escapeHtml(t("spoolman.repairDownload"))}</button></div>`;
  document
    .getElementById("btn-download-repair")
    ?.addEventListener("click", () => {
      const blob = new Blob(
        [JSON.stringify({ mappings: approved, result }, null, 2)],
        { type: "application/json" },
      );
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "spoolman-import-repair-report.json";
      link.click();
      URL.revokeObjectURL(link.href);
    });
}

export function initSpoolmanRepairController(
  deps: SpoolmanControllerDeps,
): void {
  let repairPreview: RepairPreviewResponse | null = null;
  let exampleTimer: ReturnType<typeof setTimeout> | undefined;
  let exampleSequence = 0;
  let previewSequence = 0;

  const previewButton = document.querySelector<HTMLButtonElement>(
    "#btn-repair-preview",
  );
  const executeButton = document.querySelector<HTMLButtonElement>(
    "#btn-repair-execute",
  );
  const previewHost = document.getElementById("repair-preview-result");
  const resultHost = document.getElementById("repair-result");
  const actions = document.getElementById("repair-actions");
  if (
    !previewButton ||
    !executeButton ||
    !previewHost ||
    !resultHost ||
    !actions
  ) {
    return;
  }

  const showRepairActions = (show: boolean) => {
    actions.style.display = show ? "block" : "none";
  };
  const renderFailure = (message: string) => {
    resultHost.style.display = "block";
    resultHost.innerHTML = `<div class="fm-alert-error">${escapeHtml(message)}</div>`;
  };
  const updateRepairModeHint = () => {
    const hint = document.getElementById("repair-mode-hint");
    if (hint) {
      hint.textContent = deps.t(
        repairMode() === "server"
          ? "spoolman.repairServerHint"
          : "spoolman.repairOfflineHint",
      );
    }
  };

  const scheduleEvidenceRefresh = (row: HTMLElement, source: RepairMapping) => {
    if (exampleTimer !== undefined) clearTimeout(exampleTimer);
    const sequence = ++exampleSequence;
    exampleTimer = setTimeout(async () => {
      let mapping: ApprovedRepairMappingRequest;
      try {
        mapping = buildRepairMappingPayload(
          source,
          mappingEditsFromRow(row, source),
        );
      } catch (error) {
        const host = row.querySelector<HTMLElement>(".repair-conversion-host");
        if (host) {
          host.innerHTML = `<div class="fm-alert-error">${escapeHtml(errorMessage(error, deps))}</div>`;
        }
        return;
      }
      try {
        const response = await deps.api.previewRepairExamples(
          { mapping, samples: mappingSamples(source) },
          deps.signal(),
        );
        if (sequence !== exampleSequence) return;
        renderBackendEvidence(row, mapping.field_type, response, deps.t);
      } catch {
        if (sequence !== exampleSequence) return;
        const host = row.querySelector<HTMLElement>(".repair-conversion-host");
        if (host) {
          host.innerHTML = `<div class="fm-alert-error">${escapeHtml(deps.t("spoolman.repairExamplesFailed"))}</div>`;
        }
      }
    }, 150);
  };

  const bindMappingCardEvents = (preview: RepairPreviewResponse) => {
    previewHost
      .querySelectorAll<HTMLElement>("[data-repair-index]")
      .forEach((row) => {
        const source = preview.mappings[Number(row.dataset.repairIndex)];
        if (!source) return;
        const type = row.querySelector<HTMLSelectElement>(".repair-type");
        const details = row.querySelector<HTMLInputElement>(".repair-details");
        type?.addEventListener("change", () => {
          if (!details || !type) return;
          const previousType = type.dataset.currentType as RepairFieldType;
          const nextType = type.value as RepairFieldType;
          const previousKind = details.dataset.detailsKind;
          const state = repairDetailsState(
            source,
            nextType,
            previousType,
            details.value,
          );
          type.dataset.currentType = nextType;
          details.value = detailsValue(nextType, state.kind, state.value);
          details.dataset.detailsKind = state.kind;
          if (previousKind !== state.kind)
            details.dataset.detailsEdited = "false";
          details.disabled =
            !repairMappingInteractionState(source, nextType).editable ||
            state.disabled;
          details.required = state.required;
          const checkbox =
            row.querySelector<HTMLInputElement>(".repair-approve");
          if (checkbox) {
            checkbox.disabled = !repairMappingInteractionState(source, nextType)
              .approvable;
            if (checkbox.disabled) checkbox.checked = false;
          }
          const confidence = row.querySelector<HTMLElement>(
            ".repair-confidence-host",
          );
          if (confidence) {
            confidence.innerHTML = renderConfidence(source, nextType, deps.t);
          }
          scheduleEvidenceRefresh(row, source);
        });
        details?.addEventListener("input", () => {
          details.dataset.detailsEdited = "true";
          scheduleEvidenceRefresh(row, source);
        });
      });
  };

  previewButton.addEventListener("click", async () => {
    const mode = repairMode();
    const url =
      document.querySelector<HTMLInputElement>("#spoolman-url")?.value.trim() ??
      "";
    if (mode === "server" && !url) {
      renderFailure(deps.t("spoolman.urlRequired"));
      return;
    }
    const sequence = ++previewSequence;
    previewButton.disabled = true;
    try {
      const preview = await deps.api.previewRepair(
        { mode, url: mode === "server" ? url : null },
        deps.signal(),
      );
      if (sequence !== previewSequence) return;
      repairPreview = preview;
      previewHost.style.display = "block";
      previewHost.innerHTML = renderRepairPreview(preview, deps.t);
      bindMappingCardEvents(preview);
      showRepairActions(preview.mappings.length > 0);
      resultHost.style.display = "none";
    } catch (error) {
      if (sequence !== previewSequence) return;
      repairPreview = null;
      showRepairActions(false);
      renderFailure(errorMessage(error, deps));
    } finally {
      previewButton.disabled = false;
    }
  });

  executeButton.addEventListener("click", async () => {
    if (!repairPreview) return;
    let approved: ApprovedRepairMappingRequest[];
    try {
      approved = Array.from(
        previewHost.querySelectorAll<HTMLElement>("[data-repair-index]"),
      ).flatMap((row) => {
        if (!row.querySelector<HTMLInputElement>(".repair-approve")?.checked) {
          return [];
        }
        const source = repairPreview?.mappings[Number(row.dataset.repairIndex)];
        return source
          ? [
              buildRepairMappingPayload(
                source,
                mappingEditsFromRow(row, source),
              ),
            ]
          : [];
      });
    } catch (error) {
      if (error instanceof RepairMappingValidationError) {
        await deps.alert(deps.t("spoolman.repairChoicesRequired"));
        return;
      }
      throw error;
    }
    if (!approved.length) {
      await deps.alert(deps.t("spoolman.repairSelectOne"));
      return;
    }
    const confirmed = await deps.confirm(deps.t("spoolman.repairConfirm"), {
      title: deps.t("spoolman.repairTitle"),
      okLabel: deps.t("spoolman.repairApply"),
      isDanger: false,
    });
    if (!confirmed) return;
    executeButton.disabled = true;
    try {
      const mode = repairMode();
      const url =
        document
          .querySelector<HTMLInputElement>("#spoolman-url")
          ?.value.trim() ?? "";
      const executed = await deps.api.executeRepair(
        {
          mode,
          url: mode === "server" ? url : null,
          preview_fingerprint: repairPreview.preview_fingerprint,
          approved_mappings: approved,
        },
        deps.signal(),
      );
      renderRepairSuccess(executed, approved, deps.t);
      showRepairActions(false);
      repairPreview = null;
    } catch (error) {
      renderFailure(errorMessage(error, deps));
    } finally {
      executeButton.disabled = false;
    }
  });

  document
    .querySelectorAll<HTMLInputElement>('input[name="repair-mode"]')
    .forEach((input) => input.addEventListener("change", updateRepairModeHint));
  updateRepairModeHint();
}
