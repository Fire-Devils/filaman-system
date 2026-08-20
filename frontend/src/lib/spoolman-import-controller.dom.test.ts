// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";

import en from "../i18n/en.json";
import de from "../i18n/de.json";

import {
  initSpoolmanImportController,
  renderExtraFieldPreview,
  renderImportResult,
  renderTransparencyRepairResult,
  renderVendorPreview,
} from "./spoolman-import-controller";
import {
  controllerDeps,
  emptyImportResult,
  fakeSpoolmanApi,
  importWorkflowFixtureHtml,
} from "./spoolman-controller-test-support";

afterEach(() => {
  document.body.innerHTML = "";
});

it("uses functional import-default copy instead of a step reference", () => {
  expect(en.spoolman.extraFieldActionStep3Default).toBe("Use import default");
  expect(en.spoolman.extraFieldOverrideHint).toBe(
    "Per-field choices override the default storage option selected for this import.",
  );
  expect(de.spoolman.extraFieldActionStep3Default).toBe(
    "Importstandard verwenden",
  );
  expect(de.spoolman.extraFieldOverrideHint).toBe(
    "Die Auswahl pro Feld überschreibt die für diesen Import gewählte Standardspeicherung.",
  );
});

it("renders preview fields and sends explicit import choices", async () => {
  document.body.innerHTML = importWorkflowFixtureHtml();
  const executeImport = vi.fn(async () => emptyImportResult());
  const api = fakeSpoolmanApi({
    loadPreview: vi.fn(async () => ({
      summary: { vendors: 1, filaments: 2, spools: 2, locations: 1, colors: 2 },
      vendors: [],
      filaments: [],
      spools: [],
      locations: [],
      colors: [],
      extra_fields: [
        {
          target_type: "spool",
          key: "tag",
          label: "Tag",
          field_type: "text",
          status: "create",
        },
      ],
      extra_field_targets: ["filament", "spool"],
      extra_field_fingerprint: "fingerprint",
      warnings: [],
    })),
    executeImport,
  });
  initSpoolmanImportController(controllerDeps(api));

  document.querySelector<HTMLButtonElement>("#btn-test")!.click();
  await vi.waitFor(() => expect(api.testConnection).toHaveBeenCalled());
  document.querySelector<HTMLButtonElement>("#btn-preview")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector(".import-field-action")).not.toBeNull(),
  );
  const select = document.querySelector<HTMLSelectElement>(
    ".import-field-action",
  )!;
  select.value = "local";
  document.querySelector<HTMLButtonElement>("#btn-import")!.click();
  await vi.waitFor(() => expect(executeImport).toHaveBeenCalled());

  expect(executeImport).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "http://spoolman",
      extra_field_fingerprint: "fingerprint",
      field_actions: [{ target_type: "spool", key: "tag", action: "local" }],
    }),
    expect.any(AbortSignal),
  );
  await vi.waitFor(() =>
    expect(document.querySelector("#import-result")?.textContent).toContain(
      "spoolman.importResults",
    ),
  );
  expect(document.getElementById("preview-result")?.style.display).toBe("none");
  expect(document.getElementById("import-controls")?.style.display).toBe(
    "none",
  );
  expect(
    document.querySelector<HTMLButtonElement>("#btn-import")?.disabled,
  ).toBe(true);
});

it("preserves preview headers, overflow counts, and partial-definition notices", () => {
  const t = (key: string) =>
    key === "spoolman.andMore"
      ? "and {count} more"
      : key === "spoolman.extraFieldDefinitionsPartial"
        ? "Missing {targets}"
        : key;
  const vendors = Array.from({ length: 22 }, (_, index) => ({
    name: `Vendor ${index}`,
    url: `https://example.com/${index}`,
  }));
  const vendorHtml = renderVendorPreview(vendors, t);
  expect(vendorHtml).toContain("common.name");
  expect(vendorHtml).toContain("and 2 more");

  const fieldHtml = renderExtraFieldPreview(
    [
      {
        target_type: "spool",
        key: "tag",
        field_type: "text",
        status: "create",
        system_conflict: { count: 2, sample_record_ids: [1, 2] },
      },
    ],
    {
      typedDefinitionsAvailable: true,
      missingTargets: ["filament"],
    },
    t,
  );
  expect(fieldHtml).toContain("Missing filaments.title");
  expect(fieldHtml).toContain("spoolman.extraFieldsCreate");
  expect(fieldHtml).toContain("spoolman.extraFieldRetainedConflict");
});

it("preserves detailed import and transparency result copy", () => {
  const t = (key: string) =>
    key === "spoolman.colorAssignmentsRepaired"
      ? "Repaired {count} assignments"
      : key === "spoolman.repairTransparencyColors"
        ? "Created {created}; reused {reused}"
        : key;
  const result = {
    ...emptyImportResult(),
    manufacturers_created: 1,
    manufacturers_skipped: 3,
    extra_fields_created: 2,
    extra_values_promoted: 4,
    warnings: ["warning detail"],
  };

  const importHtml = renderImportResult(result, t);
  expect(importHtml).toContain("manufacturers.title");
  expect(importHtml).toContain("3 spoolman.skipped");
  expect(importHtml).toContain("spoolman.extraFieldSystemDefinitions");
  expect(importHtml).toContain("warning detail");
  expect(importHtml).toContain("spoolman.importAgainHint");

  const repairHtml = renderTransparencyRepairResult(
    {
      ...result,
      color_assignments_repaired: 5,
      colors_created: 1,
      colors_skipped: 2,
    },
    t,
  );
  expect(repairHtml).toContain("Repaired 5 assignments");
  expect(repairHtml).toContain("Created 1; reused 2");
});
