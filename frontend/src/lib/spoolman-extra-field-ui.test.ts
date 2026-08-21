// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  RepairMappingValidationError,
  applySpoolmanMutationState,
  bindSpoolmanImportInvalidationTriggers,
  buildImportExtraFieldResultSummary,
  buildImportFieldActions,
  buildRepairMappingPayload,
  buildSpoolmanExecuteRequest,
  buildSpoolmanPreviewRequest,
  escapeHtmlAttribute,
  formatRepairExampleValue,
  invalidateSpoolmanImportPreview,
  normalizeRepairWarnings,
  repairConfidenceReason,
  repairConfidenceTone,
  repairDetailsState,
  repairMappingInteractionState,
  resolveImportDefinitionAvailability,
  resolveImportModeAvailability,
  type RepairMapping,
} from "./spoolman-extra-field-ui";

describe("Spoolman attribute rendering", () => {
  it("encodes hostile values in rendered attributes without creating new attributes", () => {
    const hostile = `" autofocus onfocus="globalThis.pwned=1`;
    expect(escapeHtmlAttribute(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;");

    document.body.innerHTML = `
      <select id="field" data-key="${escapeHtmlAttribute(hostile)}"></select>
      <input id="label" value="${escapeHtmlAttribute(hostile)}" />
      <input id="unit" value="${escapeHtmlAttribute(hostile)}" />
      <input id="choices" value="${escapeHtmlAttribute(JSON.stringify([hostile]))}" />
      <code id="sample" title="${escapeHtmlAttribute(hostile)}"></code>
    `;

    expect(document.querySelector<HTMLElement>("#field")?.dataset.key).toBe(hostile);
    expect(document.querySelector<HTMLInputElement>("#label")?.value).toBe(hostile);
    expect(document.querySelector<HTMLInputElement>("#unit")?.value).toBe(hostile);
    expect(document.querySelector<HTMLInputElement>("#choices")?.value).toBe(
      JSON.stringify([hostile]),
    );
    expect(document.querySelector<HTMLElement>("#sample")?.title).toBe(hostile);
    expect(document.querySelectorAll("[autofocus], [onfocus]")).toHaveLength(0);
  });
});

describe("Spoolman mutation coordination", () => {
  it("disables every mutation control while an operation is running", () => {
    const controls = {
      importButton: { disabled: false },
      transparencyRepairButton: { disabled: false },
      richRepairButton: { disabled: false },
    };

    applySpoolmanMutationState(controls, true, 3, true);

    expect(controls).toEqual({
      importButton: { disabled: true },
      transparencyRepairButton: { disabled: true },
      richRepairButton: { disabled: true },
    });
  });

  it("restores only mutation controls with an available action", () => {
    const controls = {
      importButton: { disabled: true },
      transparencyRepairButton: { disabled: true },
      richRepairButton: { disabled: true },
    };

    applySpoolmanMutationState(controls, false, 0, false);

    expect(controls).toEqual({
      importButton: { disabled: false },
      transparencyRepairButton: { disabled: true },
      richRepairButton: { disabled: true },
    });
  });

  it("keeps import disabled while no fingerprinted preview is ready", () => {
    const controls = {
      importButton: { disabled: false },
      transparencyRepairButton: { disabled: true },
      richRepairButton: { disabled: true },
    };

    applySpoolmanMutationState(controls, false, 0, false, false);

    expect(controls.importButton.disabled).toBe(true);
  });

  it("clears and disables stale import state immediately on URL edits and retests", () => {
    document.body.innerHTML = `
      <input id="spoolman-url" />
      <button id="btn-test"></button>
      <section id="step-preview"></section>
      <section id="step-import"></section>
      <div id="preview-result"><select class="import-field-action"></select></div>
      <button id="btn-import"></button>
      <button id="btn-repair-transparency"></button>
      <div id="transparency-repair-note"></div>
      <strong id="transparency-repair-count">2 repairs</strong>
    `;
    const state = {
      connectedUrl: "http://old.test",
      previewData: { extra_field_fingerprint: "old-fingerprint" },
      transparencyRepairCandidates: 2,
      transparencyRepairPlanDigest: "old-digest",
      revision: 7,
    };
    const controls = {
      previewStep: document.querySelector<HTMLElement>("#step-preview")!,
      importStep: document.querySelector<HTMLElement>("#step-import")!,
      previewResult: document.querySelector<HTMLElement>("#preview-result")!,
      importButton: document.querySelector<HTMLButtonElement>("#btn-import")!,
      transparencyRepairButton: document.querySelector<HTMLButtonElement>(
        "#btn-repair-transparency",
      )!,
      transparencyRepairNote: document.querySelector<HTMLElement>(
        "#transparency-repair-note",
      )!,
      transparencyRepairCount: document.querySelector<HTMLElement>(
        "#transparency-repair-count",
      )!,
    };
    const invalidateCurrent = () => invalidateSpoolmanImportPreview(state, controls);
    bindSpoolmanImportInvalidationTriggers(
      document.querySelector<HTMLInputElement>("#spoolman-url")!,
      document.querySelector<HTMLButtonElement>("#btn-test")!,
      invalidateCurrent,
    );

    document.querySelector<HTMLInputElement>("#spoolman-url")!.dispatchEvent(
      new Event("input", { bubbles: true }),
    );

    expect(state).toEqual({
      connectedUrl: "",
      previewData: null,
      transparencyRepairCandidates: 0,
      transparencyRepairPlanDigest: "",
      revision: 8,
    });
    expect(controls.previewResult.children).toHaveLength(0);
    expect(controls.previewStep.style.pointerEvents).toBe("none");
    expect(controls.importStep.style.pointerEvents).toBe("none");
    expect(controls.importButton.disabled).toBe(true);
    expect(controls.transparencyRepairButton.disabled).toBe(true);
    expect(controls.transparencyRepairButton.classList.contains("hidden")).toBe(true);
    expect(controls.transparencyRepairNote.classList.contains("hidden")).toBe(true);
    expect(controls.transparencyRepairCount.textContent).toBe("");

    state.connectedUrl = "http://retested.test";
    state.previewData = { extra_field_fingerprint: "second-fingerprint" };
    controls.importButton.disabled = false;
    document.querySelector<HTMLButtonElement>("#btn-test")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(state.connectedUrl).toBe("");
    expect(state.previewData).toBeNull();
    expect(state.revision).toBe(9);
    expect(controls.importButton.disabled).toBe(true);
  });
});

describe("Spoolman repair warnings", () => {
  it("keeps non-empty warning strings and drops malformed values", () => {
    expect(
      normalizeRepairWarnings([
        "  Filament definitions are unavailable.  ",
        "",
        null,
        7,
        { message: "not trusted" },
      ]),
    ).toEqual(["Filament definitions are unavailable."]);
    expect(normalizeRepairWarnings("not an array")).toEqual([]);
  });
});

const source: RepairMapping = {
  target_type: "filament",
  key: "drying_temperature",
  label: "Drying temperature",
  field_type: "number",
  source_field_type: "integer",
  config: { decimal_places: 0, unit: "°C" },
  options: null,
  default_value: "55",
};

describe("Spoolman repair field controls", () => {
  it("shows units only for number and range fields", () => {
    expect(repairDetailsState(source, "number")).toEqual({
      kind: "unit",
      value: "°C",
      disabled: false,
      required: false,
    });
    expect(repairDetailsState(source, "date")).toEqual({
      kind: "none",
      value: "",
      disabled: true,
      required: false,
    });
  });

  it("does not carry a numeric unit into dropdown choices", () => {
    expect(repairDetailsState(source, "dropdown", "number", "°C")).toEqual({
      kind: "choices",
      value: "[]",
      disabled: false,
      required: true,
    });
  });

  it("keeps edited details when switching within the same type family", () => {
    expect(
      repairDetailsState(source, "range", "number", "degrees"),
    ).toMatchObject({ kind: "unit", value: "degrees" });
  });
});

describe("Spoolman repair preview evidence", () => {
  it("keeps no-promotable unresolved mappings editable but unapproved initially", () => {
    expect(
      repairMappingInteractionState({
        ...source,
        status: "ready",
        confidence: "high",
      }),
    ).toEqual({ editable: true, approvable: true });
    expect(
      repairMappingInteractionState({
        ...source,
        status: "no_promotable",
        confidence: "unresolved",
      }),
    ).toEqual({ editable: true, approvable: false });
  });

  it("blocks editing and approval for conflicting mappings", () => {
    expect(
      repairMappingInteractionState({ ...source, status: "conflict" }),
    ).toEqual({ editable: false, approvable: false });
  });

  it("keeps invalid-key mappings blocked after a manual type choice", () => {
    expect(
      repairMappingInteractionState(
        {
          ...source,
          key: "invalid key",
          field_type: "text",
          status: "no_promotable",
          confidence: "unresolved",
          confidence_reason: "invalid_key",
        },
        "number",
      ),
    ).toEqual({ editable: false, approvable: false });
  });

  it("makes an identity-valid mapping approvable after a manual type choice", () => {
    const unresolved: RepairMapping = {
      ...source,
      field_type: "text",
      status: "no_promotable",
      confidence: "unresolved",
    };

    expect(repairMappingInteractionState(unresolved, "number")).toEqual({
      editable: true,
      approvable: true,
    });
  });

  it.each([
    ["authoritative", "info"],
    ["high", "success"],
    ["medium", "warning"],
    ["low", "error"],
    ["unresolved", "neutral"],
  ] as const)("maps %s confidence to the %s tone", (confidence, tone) => {
    expect(repairConfidenceTone(confidence)).toBe(tone);
  });

  it("uses the audited reason and replaces it after a manual type change", () => {
    const legacyText: RepairMapping = {
      ...source,
      field_type: "text",
      source_field_type: "text",
      confidence: "low",
      confidence_reason: "legacy_scalar",
    };

    expect(repairConfidenceReason(legacyText)).toBe("legacy_text");
    expect(repairConfidenceReason(legacyText, "datetime")).toBe("manual");
  });

  it.each([
    ["text", "legacy_text"],
    ["number", "legacy_number"],
    ["checkbox", "legacy_checkbox"],
  ] as const)(
    "explains which source types a legacy %s value could represent",
    (fieldType, reason) => {
      expect(
        repairConfidenceReason({
          ...source,
          field_type: fieldType,
          confidence: "low",
          confidence_reason: "legacy_scalar",
        }),
      ).toBe(reason);
    },
  );

  it("falls back to a confidence-specific reason for older previews", () => {
    expect(
      repairConfidenceReason({
        ...source,
        confidence: "high",
        confidence_reason: undefined,
      }),
    ).toBe("generic_high");
  });

  it("formats actual converted values for compact before/after examples", () => {
    expect(
      formatRepairExampleValue(
        "true",
        "checkbox",
        false,
        "Checked",
        "Unchecked",
      ),
    ).toBe("true");
    expect(
      formatRepairExampleValue(true, "checkbox", true, "Checked", "Unchecked"),
    ).toBe("Checked");
    expect(
      formatRepairExampleValue(
        { min: 190, max: 230 },
        "range",
        true,
        "Checked",
        "Unchecked",
      ),
    ).toBe("190 – 230");
    expect(
      formatRepairExampleValue(
        '"2026-07-27T15:45:30Z"',
        "date",
        false,
        "Checked",
        "Unchecked",
      ),
    ).toBe("2026-07-27T15:45:30Z");
  });

  it("adds a trimmed unit only to converted number and range examples", () => {
    expect(
      formatRepairExampleValue(0.6, "number", true, "Checked", "Unchecked", " mm "),
    ).toBe("0.6 mm");
    expect(
      formatRepairExampleValue(
        { min: 0.6, max: 1.2 },
        "range",
        true,
        "Checked",
        "Unchecked",
        "mm",
      ),
    ).toBe("0.6 – 1.2 mm");
    expect(
      formatRepairExampleValue(0.6, "number", true, "Checked", "Unchecked", "  "),
    ).toBe("0.6");
    expect(
      formatRepairExampleValue("0.6", "number", false, "Checked", "Unchecked", "mm"),
    ).toBe("0.6");
  });

});

describe("Spoolman repair payloads", () => {
  const choiceSource: RepairMapping = {
    ...source,
    field_type: "dropdown",
    source_field_type: "choice",
    options: ["PLA, CF", "  padded  ", ""],
    default_value: "PLA, CF",
  };

  it("preserves an untouched choice array and its default exactly", () => {
    const payload = buildRepairMappingPayload(choiceSource, {
      label: "Material profile",
      fieldType: "dropdown",
      details: JSON.stringify(choiceSource.options),
      action: "local",
    });

    expect(payload).toMatchObject({
      label: "Material profile",
      field_type: "dropdown",
      options: ["PLA, CF", "  padded  ", ""],
      config: null,
      default_value: "PLA, CF",
      action: "local",
    });
  });

  it("applies an explicit structured choice edit without normalization", () => {
    const editedOptions = ["PETG, CF", "  preserve me  ", ""];
    const payload = buildRepairMappingPayload(
      { ...choiceSource, default_value: null },
      {
        label: choiceSource.label,
        fieldType: "dropdown",
        details: JSON.stringify(editedOptions),
        detailsEdited: true,
        action: "system",
      },
    );

    expect(payload.options).toEqual(editedOptions);
  });

  it.each([
    ["dropdown", "PLA, CF", JSON.stringify(["PETG"])],
    ["multiselect", JSON.stringify(["PLA, CF", ""]), JSON.stringify(["PLA, CF"])],
  ] as const)(
    "rejects an edited %s option list that invalidates the retained default",
    (fieldType, defaultValue, details) => {
      expect(() =>
        buildRepairMappingPayload(
          {
            ...choiceSource,
            field_type: fieldType,
            default_value: defaultValue,
          },
          {
            label: choiceSource.label,
            fieldType,
            details,
            detailsEdited: true,
            action: "system",
          },
        ),
      ).toThrow(RepairMappingValidationError);
    },
  );

  it("rejects dropdown and multi-select mappings without choices", () => {
    expect(() =>
      buildRepairMappingPayload(source, {
        label: source.label,
        fieldType: "multiselect",
        details: "[]",
        detailsEdited: true,
        action: "system",
      }),
    ).toThrow(RepairMappingValidationError);
  });

  it("preserves numeric configuration without leaking it to other types", () => {
    expect(
      buildRepairMappingPayload(source, {
        label: source.label,
        fieldType: "range",
        details: "K",
        action: "system",
      }).config,
    ).toEqual({ decimal_places: 0, unit: "K" });

    expect(
      buildRepairMappingPayload(source, {
        label: source.label,
        fieldType: "text",
        details: "",
        action: "system",
      }).config,
    ).toBeNull();
  });
});

describe("Spoolman import overrides", () => {
  it("opts the admin preview into rich extra-field results", () => {
    expect(buildSpoolmanPreviewRequest("http://spoolman.test")).toEqual({
      url: "http://spoolman.test",
      include_transparency_repairs: true,
      include_extra_fields: true,
    });
  });

  it("requires a bound fingerprint for the rich admin execute request", () => {
    expect(() =>
      buildSpoolmanExecuteRequest({
        url: "http://spoolman.test",
        extraFieldFingerprint: "",
        extraFieldMode: "system",
        fieldActions: [],
      }),
    ).toThrow(/preview fingerprint/i);

    expect(
      buildSpoolmanExecuteRequest({
        url: "http://spoolman.test",
        extraFieldFingerprint: "fingerprint-123",
        extraFieldMode: "local",
        fieldActions: [
          { target_type: "filament", key: "profile", action: "system" },
        ],
      }),
    ).toEqual({
      url: "http://spoolman.test",
      include_extra_fields: true,
      extra_field_fingerprint: "fingerprint-123",
      extra_field_mode: "local",
      field_actions: [
        { target_type: "filament", key: "profile", action: "system" },
      ],
    });
  });

  it("summarizes created, reused, local, converted, and preserved fields", () => {
    expect(
      buildImportExtraFieldResultSummary({
        extra_fields_created: 6,
        extra_fields_reused: 2,
        extra_local_definitions: 1,
        extra_values_promoted: 29,
        extra_values_preserved: 3,
        extra_fields_conflicted: 1,
      }),
    ).toEqual({
      systemCreated: 6,
      systemReused: 2,
      localCreated: 1,
      valuesConverted: 29,
      valuesPreserved: 3,
      conflicts: 1,
      hasActivity: true,
    });
  });

  it("hides the extra-field result section when every counter is absent", () => {
    expect(buildImportExtraFieldResultSummary({})).toEqual({
      systemCreated: 0,
      systemReused: 0,
      localCreated: 0,
      valuesConverted: 0,
      valuesPreserved: 0,
      conflicts: 0,
      hasActivity: false,
    });
  });

  it("omits inherited and incomplete selections", () => {
    expect(
      buildImportFieldActions([
        {
          targetType: "filament",
          key: "drying_temperature",
          action: "inherit",
        },
        { targetType: "spool", key: "inspection", action: "local" },
        { targetType: undefined, key: "ignored", action: "system" },
      ]),
    ).toEqual([
      {
        target_type: "spool",
        key: "inspection",
        action: "local",
      },
    ]);
  });

  it("falls back explicitly when typed definitions are unavailable", () => {
    expect(resolveImportModeAvailability("system", false)).toEqual({
      mode: "legacy",
      typedModesDisabled: true,
    });
    expect(resolveImportModeAvailability("local", false)).toEqual({
      mode: "legacy",
      typedModesDisabled: true,
    });
    expect(resolveImportModeAvailability("preserve", false)).toEqual({
      mode: "preserve",
      typedModesDisabled: true,
    });
    expect(resolveImportModeAvailability("system", true)).toEqual({
      mode: "system",
      typedModesDisabled: false,
    });
  });

  it("detects complete, partial, and unavailable typed field targets", () => {
    expect(
      resolveImportDefinitionAvailability(["vendor", "filament", "spool"]),
    ).toEqual({
      typedDefinitionsAvailable: true,
      missingTargets: [],
    });
    expect(resolveImportDefinitionAvailability(["filament"])).toEqual({
      typedDefinitionsAvailable: true,
      missingTargets: ["spool"],
    });
    expect(resolveImportDefinitionAvailability(["vendor"])).toEqual({
      typedDefinitionsAvailable: false,
      missingTargets: ["filament", "spool"],
    });
    expect(resolveImportDefinitionAvailability(undefined)).toEqual({
      typedDefinitionsAvailable: false,
      missingTargets: ["filament", "spool"],
    });
  });
});
