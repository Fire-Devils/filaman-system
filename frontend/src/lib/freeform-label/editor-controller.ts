// Stable public entry points; implementation ownership lives in focused modules.
export type {
  LabelAssetMetadata,
  LabelAssetClient,
  LabelFieldModifier,
  FreeformEditorState,
  FreeformEditorOptions,
  FreeformLabelDesignerEditorOptions,
  FreeformLabelDesignerEditorController,
  JsonApplyResult,
} from './editor-types'
export { createFreeformEditorController, type FreeformEditorController } from './editor-state'
export { bindFreeformEditorDom, type BindFreeformEditorDomOptions } from './editor-dom'
export {
  getFreeformLabelPresetNames,
  loadFreeformLabelDesign,
  loadFreeformLabelPresetDesign,
  persistFreeformLabelDesign,
} from './editor-storage'
export { initFreeformLabelDesignerEditor, FREEFORM_EDITOR_BREAKPOINT_PX } from './editor-page'
