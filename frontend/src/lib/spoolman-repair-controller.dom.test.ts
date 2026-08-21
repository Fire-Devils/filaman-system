// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";

import { initSpoolmanRepairController } from "./spoolman-repair-controller";
import {
  controllerDeps,
  fakeSpoolmanApi,
  repairPreviewWithDatetimeMapping,
  repairWorkflowFixtureHtml,
} from "./spoolman-controller-test-support";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("requests backend examples after a manual type change", async () => {
  document.body.innerHTML = repairWorkflowFixtureHtml();
  const previewRepairExamples = vi.fn(async () => ({
    conversion_examples: [
      {
        source: '"2026-07-27T15:45:30Z"',
        converted: "2026-07-27",
      },
    ],
    invalid_sample_indexes: [],
  }));
  const api = fakeSpoolmanApi({
    previewRepair: vi.fn(async () => repairPreviewWithDatetimeMapping()),
    previewRepairExamples,
  });
  initSpoolmanRepairController(controllerDeps(api));

  document.querySelector<HTMLButtonElement>("#btn-repair-preview")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector(".repair-type")).not.toBeNull(),
  );
  const type = document.querySelector<HTMLSelectElement>(".repair-type")!;
  type.value = "date";
  type.dispatchEvent(new Event("change", { bubbles: true }));

  await vi.waitFor(() => expect(previewRepairExamples).toHaveBeenCalled());
  expect(
    document.querySelector(".repair-conversion-host")?.textContent,
  ).toContain("2026-07-27");
});

it("preserves existing-definition actions and repair diagnostics", async () => {
  document.body.innerHTML = repairWorkflowFixtureHtml();
  const preview = repairPreviewWithDatetimeMapping();
  preview.warnings = ["Definition metadata was unavailable"];
  preview.summary.collisions = 2;
  preview.mappings[0] = {
    ...preview.mappings[0],
    existing: true,
    status: "no_promotable",
    system_conflict: { count: 2, sample_record_ids: [4, 9] },
  };
  const api = fakeSpoolmanApi({ previewRepair: vi.fn(async () => preview) });
  initSpoolmanRepairController(controllerDeps(api));

  document.querySelector<HTMLButtonElement>("#btn-repair-preview")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector(".repair-action")).not.toBeNull(),
  );

  const action = document.querySelector<HTMLSelectElement>(".repair-action")!;
  expect(action.options[0].textContent).toBe(
    "spoolman.extraFieldActionReuseSystem",
  );
  expect(action.options[1].disabled).toBe(true);
  expect(
    document.querySelector("#repair-preview-result")?.textContent,
  ).toContain("Definition metadata was unavailable");
  expect(
    document.querySelector("#repair-preview-result")?.textContent,
  ).toContain("spoolman.repairNoPromotable");
  expect(
    document.querySelector("#repair-preview-result")?.textContent,
  ).toContain("spoolman.repairCollisions");
});

it("renders the translated empty-state explanation", async () => {
  document.body.innerHTML = repairWorkflowFixtureHtml();
  const api = fakeSpoolmanApi({
    previewRepair: vi.fn(async () => ({
      ...repairPreviewWithDatetimeMapping(),
      summary: {
        imported_records: 3,
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
  });
  const deps = controllerDeps(api);
  deps.t = (key) =>
    key === "spoolman.repairAlreadyHandled"
      ? "Handled {count} imported records"
      : key;
  initSpoolmanRepairController(deps);

  document.querySelector<HTMLButtonElement>("#btn-repair-preview")!.click();
  await vi.waitFor(() =>
    expect(
      document.querySelector("#repair-preview-result")?.textContent,
    ).toContain("Handled 3 imported records"),
  );
  expect(document.getElementById("repair-actions")?.style.display).toBe("none");
});
