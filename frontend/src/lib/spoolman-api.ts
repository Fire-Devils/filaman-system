import type {
  ImportStorageAction,
  ImportStorageMode,
  RepairMapping,
  RepairStorageAction,
} from "./spoolman-extra-field-ui";

export type RepairMode = "server" | "offline";

export interface SpoolmanConnectionResponse {
  status: string;
  url: string;
  info: Record<string, unknown>;
}

export interface SpoolmanSummary {
  vendors: number;
  filaments: number;
  spools: number;
  locations: number;
  colors: number;
}

export interface SpoolmanExtraFieldPreview {
  target_type: string;
  key: string;
  label?: string;
  field_type?: string;
  status: string;
  reason?: string;
  conflicting_key?: string;
  system_conflict?: { count: number; sample_record_ids: number[] };
  [key: string]: unknown;
}

export interface SpoolmanPreviewRequest {
  url: string;
  include_transparency_repairs?: boolean;
}

export interface SpoolmanPreviewResponse {
  summary: SpoolmanSummary;
  vendors: Record<string, unknown>[];
  filaments: Record<string, unknown>[];
  spools: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  colors: Array<{ name: string; hex_code: string }>;
  extra_fields?: SpoolmanExtraFieldPreview[];
  extra_field_targets?: string[];
  extra_field_fingerprint?: string | null;
  warnings?: string[];
  transparency_repair_candidates?: number;
  transparency_repair_plan_digest?: string | null;
}

export interface SpoolmanFieldActionRequest {
  target_type: string;
  key: string;
  action: Exclude<ImportStorageAction, "inherit">;
}

export interface SpoolmanExecuteRequest {
  url: string;
  extra_field_fingerprint?: string | null;
  extra_field_mode: ImportStorageMode;
  field_actions: SpoolmanFieldActionRequest[];
}

export interface TransparencyRepairRequest {
  url: string;
  plan_digest: string;
}

export interface SpoolmanImportResult {
  manufacturers_created: number;
  manufacturers_skipped: number;
  locations_created: number;
  locations_skipped: number;
  colors_created: number;
  colors_skipped: number;
  color_assignments_repaired?: number;
  filaments_created: number;
  filaments_skipped: number;
  spools_created: number;
  spools_skipped: number;
  extra_fields_created?: number;
  extra_fields_reused?: number;
  extra_fields_conflicted?: number;
  extra_values_promoted?: number;
  extra_values_preserved?: number;
  extra_local_definitions?: number;
  errors: string[];
  warnings: string[];
}

export interface RepairPreviewRequest {
  mode: RepairMode;
  url?: string | null;
}

export interface RepairSummary {
  imported_records: number;
  records_scanned: number;
  fields_found: number;
  promotable: number;
  collisions: number;
  invalid: number;
  unresolved: number;
}

export interface RepairPreviewResponse {
  mode: RepairMode;
  preview_fingerprint: string;
  summary: RepairSummary;
  mappings: RepairMapping[];
  examples: Array<Record<string, unknown>>;
  warnings?: string[];
  extra_field_targets?: string[];
}

export type ApprovedRepairMappingRequest = RepairMapping & {
  action: RepairStorageAction;
};

export interface RepairExecuteRequest extends RepairPreviewRequest {
  preview_fingerprint: string;
  approved_mappings: ApprovedRepairMappingRequest[];
}

export interface RepairExecuteResponse {
  definitions_created: number;
  local_definitions_created: number;
  records_updated: number;
  values_promoted: number;
  values_preserved: number;
  report: Array<Record<string, unknown>>;
}

export interface RepairExamplePreviewRequest {
  mapping: ApprovedRepairMappingRequest;
  samples: unknown[];
}

export interface RepairExamplePreviewResponse {
  conversion_examples: Array<{ source: unknown; converted: unknown }>;
  invalid_sample_indexes: number[];
}

export class SpoolmanApiError extends Error {
  readonly name = "SpoolmanApiError";

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SpoolmanApiOptions {
  fetchImpl?: typeof fetch;
  csrfToken: () => string;
}

function errorDetail(data: unknown): { code?: string; message?: string } {
  if (!data || typeof data !== "object" || !("detail" in data)) return {};
  const detail = (data as { detail?: unknown }).detail;
  if (!detail || typeof detail !== "object") return {};
  const value = detail as { code?: unknown; message?: unknown };
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

export function createSpoolmanApi(options: SpoolmanApiOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": options.csrfToken(),
      },
      credentials: "include",
      body: JSON.stringify(body),
      signal,
    });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = errorDetail(data);
      throw new SpoolmanApiError(
        response.status,
        detail.code ?? "request_failed",
        detail.message ?? `Request failed with status ${response.status}`,
      );
    }
    return data as T;
  }

  return {
    testConnection: (url: string, signal?: AbortSignal) =>
      post<SpoolmanConnectionResponse>(
        "/api/v1/admin/system/spoolman-import/test-connection",
        { url },
        signal,
      ),
    loadPreview: (request: SpoolmanPreviewRequest, signal?: AbortSignal) =>
      post<SpoolmanPreviewResponse>(
        "/api/v1/admin/system/spoolman-import/preview",
        { ...request, include_extra_fields: true },
        signal,
      ),
    executeImport: (request: SpoolmanExecuteRequest, signal?: AbortSignal) =>
      post<SpoolmanImportResult>(
        "/api/v1/admin/system/spoolman-import/execute",
        { ...request, include_extra_fields: true },
        signal,
      ),
    repairTransparency: (
      request: TransparencyRepairRequest,
      signal?: AbortSignal,
    ) =>
      post<SpoolmanImportResult>(
        "/api/v1/admin/system/spoolman-import/repair-transparency",
        request,
        signal,
      ),
    previewRepair: (request: RepairPreviewRequest, signal?: AbortSignal) =>
      post<RepairPreviewResponse>(
        "/api/v1/admin/system/spoolman-import/repair/preview",
        request,
        signal,
      ),
    previewRepairExamples: (
      request: RepairExamplePreviewRequest,
      signal?: AbortSignal,
    ) =>
      post<RepairExamplePreviewResponse>(
        "/api/v1/admin/system/spoolman-import/repair/examples",
        request,
        signal,
      ),
    executeRepair: (request: RepairExecuteRequest, signal?: AbortSignal) =>
      post<RepairExecuteResponse>(
        "/api/v1/admin/system/spoolman-import/repair/execute",
        request,
        signal,
      ),
  };
}

export type SpoolmanApi = ReturnType<typeof createSpoolmanApi>;
