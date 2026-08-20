import { vi } from "vitest";

import type {
  RepairPreviewResponse,
  SpoolmanApi,
  SpoolmanImportResult,
} from "./spoolman-api";
import type { SpoolmanControllerDeps } from "./spoolman-controller-types";

export function emptyImportResult(): SpoolmanImportResult {
  return {
    manufacturers_created: 0,
    manufacturers_skipped: 0,
    locations_created: 0,
    locations_skipped: 0,
    colors_created: 0,
    colors_skipped: 0,
    filaments_created: 0,
    filaments_skipped: 0,
    spools_created: 0,
    spools_skipped: 0,
    errors: [],
    warnings: [],
  };
}

export function fakeSpoolmanApi(
  overrides: Partial<SpoolmanApi> = {},
): SpoolmanApi {
  return {
    testConnection: vi.fn(async (url: string) => ({ status: "ok", url, info: {} })),
    loadPreview: vi.fn(async () => ({
      summary: { vendors: 0, filaments: 0, spools: 0, locations: 0, colors: 0 },
      vendors: [],
      filaments: [],
      spools: [],
      locations: [],
      colors: [],
    })),
    executeImport: vi.fn(async () => emptyImportResult()),
    repairTransparency: vi.fn(async () => emptyImportResult()),
    previewRepair: vi.fn(async () => ({
      mode: "offline" as const,
      preview_fingerprint: "a".repeat(64),
      summary: {
        imported_records: 0,
        records_scanned: 0,
        fields_found: 0,
        promotable: 0,
        collisions: 0,
        invalid: 0,
        unresolved: 0,
      },
      mappings: [],
      examples: [],
    })),
    previewRepairExamples: vi.fn(async () => ({
      conversion_examples: [],
      invalid_sample_indexes: [],
    })),
    executeRepair: vi.fn(async () => ({
      definitions_created: 0,
      local_definitions_created: 0,
      records_updated: 0,
      values_promoted: 0,
      values_preserved: 0,
      report: [],
    })),
    ...overrides,
  } as SpoolmanApi;
}

export function controllerDeps(api: SpoolmanApi): SpoolmanControllerDeps {
  return {
    api,
    t: (key) => key,
    signal: () => new AbortController().signal,
    confirm: vi.fn(async () => true),
    alert: vi.fn(async () => undefined),
  };
}

export function importWorkflowFixtureHtml(): string {
  return `
    <div id="step-connection">
      <input id="spoolman-url" value="http://spoolman" />
      <button id="btn-test">test</button>
      <div id="connection-result"></div>
    </div>
    <div id="step-preview">
      <button id="btn-preview">preview</button>
      <div id="preview-result"></div>
    </div>
    <div id="step-import">
      <div id="import-controls">
        <select id="extra-field-mode">
          <option value="system" selected>system</option>
          <option value="local">local</option>
          <option value="preserve">preserve</option>
          <option value="legacy">legacy</option>
        </select>
        <button id="btn-import">import</button>
        <button id="btn-repair-transparency" class="hidden">repair alpha</button>
        <div id="transparency-repair-note" class="hidden"></div>
        <strong id="transparency-repair-count"></strong>
      </div>
      <div id="import-progress"><div id="import-bar"></div><p id="import-status"></p></div>
      <div id="import-result"></div>
    </div>
  `;
}

export function repairWorkflowFixtureHtml(): string {
  return `
    <input id="spoolman-url" value="http://spoolman" />
    <input type="radio" name="repair-mode" value="server" />
    <input type="radio" name="repair-mode" value="offline" checked />
    <p id="repair-mode-hint"></p>
    <button id="btn-repair-preview">scan</button>
    <div id="repair-preview-result"></div>
    <div id="repair-actions"><button id="btn-repair-execute">apply</button></div>
    <div id="repair-result"></div>
  `;
}

export function repairPreviewWithDatetimeMapping(): RepairPreviewResponse {
  return {
    mode: "offline",
    preview_fingerprint: "a".repeat(64),
    summary: {
      imported_records: 1,
      records_scanned: 1,
      fields_found: 1,
      promotable: 1,
      collisions: 0,
      invalid: 0,
      unresolved: 0,
    },
    mappings: [
      {
        target_type: "spool",
        key: "dry",
        label: "Dry",
        field_type: "datetime",
        source_field_type: "datetime",
        confidence: "medium",
        confidence_reason: "date_pattern",
        occurrences: 1,
        promotable_occurrences: 1,
        preserved_occurrences: 0,
        status: "ready",
        conversion_examples: [
          {
            source: '"2026-07-27T15:45:30Z"',
            converted: "2026-07-27T15:45:30Z",
          },
        ],
      },
    ],
    examples: [],
  };
}
