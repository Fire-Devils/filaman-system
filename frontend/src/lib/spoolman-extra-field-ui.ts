import { escapeHtml } from "./extra-fields";

export const repairFieldTypes = [
  "text",
  "number",
  "range",
  "dropdown",
  "multiselect",
  "checkbox",
  "date",
  "datetime",
  "url",
  "textarea",
] as const;

export type RepairFieldType = (typeof repairFieldTypes)[number];

export function escapeHtmlAttribute(value: unknown): string {
  return escapeHtml(value == null ? "" : String(value));
}
export type RepairStorageAction = "system" | "local" | "preserve";
export type RepairConfidence =
  | "authoritative"
  | "high"
  | "medium"
  | "low"
  | "unresolved";
export type RepairConfidenceReason =
  | "source_definition"
  | "structured_values"
  | "date_pattern"
  | "url_pattern"
  | "majority_match"
  | "legacy_text"
  | "legacy_number"
  | "legacy_checkbox"
  | "legacy_scalar"
  | "fallback_text"
  | "mixed_text"
  | "invalid_key"
  | "mixed_values"
  | "manual"
  | "generic_high"
  | "generic_medium"
  | "generic_low"
  | "generic_unresolved";
export type RepairConfidenceTone =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "neutral";
export type RepairMappingStatus = "ready" | "no_promotable" | "conflict";
export type ImportStorageAction =
  | "inherit"
  | "system"
  | "local"
  | "preserve"
  | "legacy";
export type ImportStorageMode = Exclude<ImportStorageAction, "inherit">;
export type ImportFieldTarget = "filament" | "spool";
export interface ImportDefinitionAvailability {
  typedDefinitionsAvailable: boolean;
  missingTargets: ImportFieldTarget[];
}

export interface ImportExtraFieldResultSummary {
  systemCreated: number;
  systemReused: number;
  localCreated: number;
  valuesConverted: number;
  valuesPreserved: number;
  conflicts: number;
  hasActivity: boolean;
}

export interface SpoolmanMutationControls {
  importButton: { disabled: boolean };
  transparencyRepairButton: { disabled: boolean };
  richRepairButton: { disabled: boolean };
}

export interface SpoolmanImportPreviewState {
  connectedUrl: string;
  previewData: unknown | null;
  transparencyRepairCandidates: number;
  transparencyRepairPlanDigest: string;
  revision: number;
}

export interface SpoolmanImportInvalidationControls {
  previewStep: HTMLElement;
  importStep: HTMLElement;
  previewResult: HTMLElement;
  importButton: HTMLButtonElement;
  transparencyRepairButton: HTMLButtonElement;
  transparencyRepairNote: HTMLElement;
  transparencyRepairCount: HTMLElement;
}

export function applySpoolmanMutationState(
  controls: SpoolmanMutationControls,
  running: boolean,
  transparencyRepairCandidates: number,
  richRepairAvailable: boolean,
  importReady = true,
): void {
  controls.importButton.disabled = running || !importReady;
  controls.transparencyRepairButton.disabled =
    running || transparencyRepairCandidates === 0;
  controls.richRepairButton.disabled = running || !richRepairAvailable;
}

function disableImportStep(element: HTMLElement): void {
  element.style.opacity = "0.5";
  element.style.pointerEvents = "none";
}

export function invalidateSpoolmanImportPreview(
  state: SpoolmanImportPreviewState,
  controls: SpoolmanImportInvalidationControls,
  options: {
    clearConnection?: boolean;
    disablePreviewStep?: boolean;
  } = {},
): void {
  state.revision += 1;
  if (options.clearConnection !== false) state.connectedUrl = "";
  state.previewData = null;
  state.transparencyRepairCandidates = 0;
  state.transparencyRepairPlanDigest = "";

  controls.previewResult.style.display = "none";
  controls.previewResult.replaceChildren();
  if (options.disablePreviewStep !== false) {
    disableImportStep(controls.previewStep);
  }
  disableImportStep(controls.importStep);
  controls.importButton.disabled = true;
  controls.transparencyRepairButton.disabled = true;
  controls.transparencyRepairButton.classList.add("hidden");
  controls.transparencyRepairNote.classList.add("hidden");
  controls.transparencyRepairCount.textContent = "";
}

export function bindSpoolmanImportInvalidationTriggers(
  urlInput: HTMLInputElement,
  testButton: HTMLButtonElement,
  invalidate: () => void,
): () => void {
  urlInput.addEventListener("input", invalidate);
  testButton.addEventListener("click", invalidate, { capture: true });
  return () => {
    urlInput.removeEventListener("input", invalidate);
    testButton.removeEventListener("click", invalidate, { capture: true });
  };
}

export function normalizeRepairWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((warning) => {
    if (typeof warning !== "string") return [];
    const normalized = warning.trim();
    return normalized ? [normalized] : [];
  });
}

export interface RepairMapping {
  target_type: "filament" | "spool";
  key: string;
  label: string;
  field_type: RepairFieldType;
  status?: RepairMappingStatus;
  confidence?: RepairConfidence;
  confidence_reason?: string;
  occurrences?: number;
  promotable_occurrences?: number;
  preserved_occurrences?: number;
  conversion_examples?: Array<{
    source: unknown;
    converted: unknown;
  }>;
  source_field_type?: string | null;
  options?: string[] | null;
  config?: Record<string, unknown> | null;
  default_value?: string | null;
  existing?: boolean;
  system_conflict?: { count: number; sample_record_ids: number[] } | null;
  [key: string]: unknown;
}

export interface RepairMappingInteractionState {
  editable: boolean;
  approvable: boolean;
}

export interface RepairMappingEdits {
  label: string;
  fieldType: RepairFieldType;
  details: string;
  detailsEdited?: boolean;
  action: RepairStorageAction;
}

export interface ImportFieldSelection {
  targetType?: string;
  key?: string;
  action: ImportStorageAction;
}

export interface ImportFieldAction {
  target_type: string;
  key: string;
  action: string;
}

export interface SpoolmanExecuteRequestInput {
  url: string;
  extraFieldFingerprint?: string | null;
  extraFieldMode: ImportStorageMode;
  fieldActions: ImportFieldAction[];
}

export class MissingImportPreviewFingerprintError extends Error {
  constructor() {
    super("A current preview fingerprint is required for rich-field import.");
    this.name = "MissingImportPreviewFingerprintError";
  }
}

export class RepairMappingValidationError extends Error {
  constructor(
    public readonly code:
      | "choices_required"
      | "choices_invalid"
      | "choice_default_invalid",
  ) {
    super(code);
  }
}

export function repairConfidenceTone(
  confidence?: string,
): RepairConfidenceTone {
  if (confidence === "authoritative") return "info";
  if (confidence === "high") return "success";
  if (confidence === "medium") return "warning";
  if (confidence === "low") return "error";
  return "neutral";
}

export function repairConfidenceReason(
  mapping: RepairMapping,
  selectedType: RepairFieldType = mapping.field_type,
): RepairConfidenceReason {
  if (selectedType !== mapping.field_type) return "manual";
  if (mapping.confidence_reason === "legacy_scalar") {
    if (selectedType === "text") return "legacy_text";
    if (selectedType === "number") return "legacy_number";
    if (selectedType === "checkbox") return "legacy_checkbox";
  }
  const supported = new Set<RepairConfidenceReason>([
    "source_definition",
    "structured_values",
    "date_pattern",
    "url_pattern",
    "majority_match",
    "legacy_scalar",
    "fallback_text",
    "mixed_text",
    "invalid_key",
    "mixed_values",
  ]);
  if (supported.has(mapping.confidence_reason as RepairConfidenceReason)) {
    return mapping.confidence_reason as RepairConfidenceReason;
  }
  if (mapping.confidence === "authoritative") return "source_definition";
  if (mapping.confidence === "high") return "generic_high";
  if (mapping.confidence === "medium") return "generic_medium";
  if (mapping.confidence === "low") return "generic_low";
  return "generic_unresolved";
}

export function repairMappingInteractionState(
  mapping: RepairMapping,
  selectedType: RepairFieldType = mapping.field_type,
): RepairMappingInteractionState {
  const editable =
    mapping.status !== "conflict" &&
    mapping.confidence_reason !== "invalid_key";
  const requiresManualType =
    mapping.status === "no_promotable" ||
    mapping.confidence === "unresolved";
  return {
    editable,
    approvable:
      editable && (!requiresManualType || selectedType !== mapping.field_type),
  };
}

export function formatRepairExampleValue(
  value: unknown,
  fieldType: RepairFieldType,
  converted: boolean,
  checkedLabel: string,
  uncheckedLabel: string,
  unit = "",
): string {
  let displayValue = value;
  if (!converted && typeof displayValue === "string") {
    try {
      displayValue = JSON.parse(displayValue);
    } catch {
      // Legacy cleaned strings are already display-ready.
    }
  }
  if (
    converted &&
    fieldType === "checkbox" &&
    typeof displayValue === "boolean"
  ) {
    return displayValue ? checkedLabel : uncheckedLabel;
  }
  if (
    converted &&
    fieldType === "range" &&
    displayValue &&
    typeof displayValue === "object" &&
    !Array.isArray(displayValue) &&
    ("min" in displayValue || "max" in displayValue)
  ) {
    const range = displayValue as { min?: unknown; max?: unknown };
    return appendRepairExampleUnit(
      `${range.min ?? "—"} – ${range.max ?? "—"}`,
      fieldType,
      converted,
      unit,
    );
  }
  if (displayValue === null) return "null";
  if (typeof displayValue === "string") return displayValue;
  if (typeof displayValue === "number" || typeof displayValue === "boolean") {
    return appendRepairExampleUnit(
      String(displayValue),
      fieldType,
      converted,
      unit,
    );
  }
  return JSON.stringify(displayValue);
}

function appendRepairExampleUnit(
  value: string,
  fieldType: RepairFieldType,
  converted: boolean,
  unit: string,
): string {
  const trimmedUnit = unit.trim();
  return converted &&
    (fieldType === "number" || fieldType === "range") &&
    trimmedUnit
    ? `${value} ${trimmedUnit}`
    : value;
}

type DetailsKind = "unit" | "choices" | "none";

function detailsKind(fieldType: RepairFieldType): DetailsKind {
  if (fieldType === "number" || fieldType === "range") return "unit";
  if (fieldType === "dropdown" || fieldType === "multiselect") return "choices";
  return "none";
}

export function repairDetailsState(
  source: RepairMapping,
  fieldType: RepairFieldType,
  previousFieldType?: RepairFieldType,
  currentValue = "",
): {
  kind: DetailsKind;
  value: string;
  disabled: boolean;
  required: boolean;
} {
  const kind = detailsKind(fieldType);
  if (kind === "none") {
    return { kind, value: "", disabled: true, required: false };
  }

  if (
    previousFieldType &&
    detailsKind(previousFieldType) === kind &&
    currentValue
  ) {
    return {
      kind,
      value: currentValue,
      disabled: false,
      required: kind === "choices",
    };
  }

  const value =
    kind === "unit"
      ? String(source.config?.unit || "")
      : JSON.stringify(source.options || []);
  return {
    kind,
    value,
    disabled: false,
    required: kind === "choices",
  };
}

export function parseRepairChoiceDetails(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RepairMappingValidationError("choices_invalid");
  }
  if (!Array.isArray(parsed) || !parsed.every((option) => typeof option === "string")) {
    throw new RepairMappingValidationError("choices_invalid");
  }
  return [...parsed];
}

function validateRetainedChoiceDefault(
  fieldType: RepairFieldType,
  options: string[],
  defaultValue: string | null | undefined,
): void {
  if (defaultValue == null) return;
  if (fieldType === "dropdown") {
    if (!options.includes(defaultValue)) {
      throw new RepairMappingValidationError("choice_default_invalid");
    }
    return;
  }
  if (fieldType !== "multiselect") return;
  let selected: unknown;
  try {
    selected = JSON.parse(defaultValue);
  } catch {
    throw new RepairMappingValidationError("choice_default_invalid");
  }
  if (
    !Array.isArray(selected) ||
    !selected.every(
      (option) => typeof option === "string" && options.includes(option),
    )
  ) {
    throw new RepairMappingValidationError("choice_default_invalid");
  }
}

export function buildRepairMappingPayload(
  source: RepairMapping,
  edits: RepairMappingEdits,
): RepairMapping & {
  action: RepairStorageAction;
  options: string[] | null;
  config: Record<string, unknown> | null;
} {
  const isNumeric = edits.fieldType === "number" || edits.fieldType === "range";
  const isChoice =
    edits.fieldType === "dropdown" || edits.fieldType === "multiselect";
  const sourceIsSameChoice =
    isChoice &&
    edits.fieldType === source.field_type &&
    (source.field_type === "dropdown" || source.field_type === "multiselect");
  const options = isChoice
    ? sourceIsSameChoice && !edits.detailsEdited
      ? [...(source.options || [])]
      : parseRepairChoiceDetails(edits.details)
    : null;
  if (isChoice && !options?.length) {
    throw new RepairMappingValidationError("choices_required");
  }

  const sourceConfig =
    source.field_type === "number" || source.field_type === "range"
      ? source.config || {}
      : {};
  const config = isNumeric
    ? {
        ...sourceConfig,
        unit: edits.details.trim() || undefined,
      }
    : null;

  const defaultValue =
    edits.fieldType === source.field_type ? source.default_value : null;
  if (isChoice && edits.detailsEdited && options) {
    validateRetainedChoiceDefault(edits.fieldType, options, defaultValue);
  }

  return {
    ...source,
    label: edits.label.trim() || source.key,
    field_type: edits.fieldType,
    options,
    config,
    default_value: defaultValue,
    action: edits.action,
  };
}

export function buildImportFieldActions(
  selections: ImportFieldSelection[],
): ImportFieldAction[] {
  return selections.flatMap((selection) => {
    if (
      selection.action === "inherit" ||
      !selection.targetType ||
      !selection.key
    ) {
      return [];
    }
    return [
      {
        target_type: selection.targetType,
        key: selection.key,
        action: selection.action,
      },
    ];
  });
}

export function buildSpoolmanPreviewRequest(url: string): {
  url: string;
  include_transparency_repairs: true;
  include_extra_fields: true;
} {
  return {
    url,
    include_transparency_repairs: true,
    include_extra_fields: true,
  };
}

export function buildSpoolmanExecuteRequest(
  input: SpoolmanExecuteRequestInput,
): {
  url: string;
  include_extra_fields: true;
  extra_field_fingerprint: string;
  extra_field_mode: ImportStorageMode;
  field_actions: ImportFieldAction[];
} {
  const fingerprint = input.extraFieldFingerprint?.trim();
  if (!fingerprint) throw new MissingImportPreviewFingerprintError();
  return {
    url: input.url,
    include_extra_fields: true,
    extra_field_fingerprint: fingerprint,
    extra_field_mode: input.extraFieldMode,
    field_actions: input.fieldActions,
  };
}

export function resolveImportModeAvailability(
  currentMode: ImportStorageMode,
  typedDefinitionsAvailable: boolean,
): {
  mode: ImportStorageMode;
  typedModesDisabled: boolean;
} {
  if (
    !typedDefinitionsAvailable &&
    (currentMode === "system" || currentMode === "local")
  ) {
    return { mode: "legacy", typedModesDisabled: true };
  }
  return {
    mode: currentMode,
    typedModesDisabled: !typedDefinitionsAvailable,
  };
}

export function resolveImportDefinitionAvailability(
  availableTargets: unknown,
): ImportDefinitionAvailability {
  const available = new Set<string>(
    Array.isArray(availableTargets)
      ? availableTargets.filter(
          (target): target is string => typeof target === "string",
        )
      : [],
  );
  const missingTargets = (["filament", "spool"] as const).filter(
    (target) => !available.has(target),
  );
  return {
    typedDefinitionsAvailable: missingTargets.length < 2,
    missingTargets,
  };
}

function importResultCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

export interface ImportExtraFieldResultCounts {
  extra_fields_created?: unknown;
  extra_fields_reused?: unknown;
  extra_local_definitions?: unknown;
  extra_values_promoted?: unknown;
  extra_values_preserved?: unknown;
  extra_fields_conflicted?: unknown;
}

export function buildImportExtraFieldResultSummary(
  result: ImportExtraFieldResultCounts,
): ImportExtraFieldResultSummary {
  const summary = {
    systemCreated: importResultCounter(result.extra_fields_created),
    systemReused: importResultCounter(result.extra_fields_reused),
    localCreated: importResultCounter(result.extra_local_definitions),
    valuesConverted: importResultCounter(result.extra_values_promoted),
    valuesPreserved: importResultCounter(result.extra_values_preserved),
    conflicts: importResultCounter(result.extra_fields_conflicted),
  };
  return {
    ...summary,
    hasActivity: Object.values(summary).some((count) => count > 0),
  };
}
