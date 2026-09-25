import { bindCanvasTextEditor } from './canvas-text-editor'
import { bindElementClipboard } from './element-clipboard'
import { bindFieldDrawer } from './field-drawer'
import { bindShapeMenu } from './shape-menu'
import { bindDesignerTooltips } from './designer-tooltips'
import { bindImageCropEditor } from './image-crop-editor'
import { bindLabelInteractions, type InteractFactory, type LabelInteractionController } from './interaction-adapter'
import { formatDesignerNumber } from './number-format'
import {
  getQrRecommendedSideMm,
  QR_QUIET_ZONE_MODULES,
  QR_RECOMMENDED_DPI,
} from './qr-readability'
import type { FreeformEditorController } from './editor-state'
import { elementLabelKeys, elementLabelFallbacks, localizedErrorMessage } from './editor-types'
import { LABEL_FONT_FAMILIES, LABEL_SHAPES, type LabelDesignElement, type LabelElementType } from './types'
import {
  buildFilamentSwatchBackground,
  getFilamentSwatchColors,
  getReadableTextColorForColors,
  type SpoolData,
} from '../label-template'

export interface BindFreeformEditorDomOptions {
  root?: ParentNode
  controller: FreeformEditorController
  editable?: boolean
  loadInteract?: () => Promise<InteractFactory>
  translate?: (key: string, fallback: string) => string
  getPreviewData?: () => SpoolData | null | undefined
}

const elementProperties = [
  'x', 'y', 'w', 'h', 'template', 'fontSizeMm',
  'fontWeight', 'assetId', 'mode', 'strokeWidthMm', 'minFontSizeMm',
] as const
function isElementProperty(value: string): value is typeof elementProperties[number] {
  return elementProperties.some(property => property === value)
}

export function bindFreeformEditorDom(options: BindFreeformEditorDomOptions) {
  const root = options.root ?? document
  const controller = options.controller
  const cleanups: Array<() => void> = []
  let interaction: LabelInteractionController | null = null
  let editable = options.editable !== false
  const translate = options.translate ?? ((_key: string, fallback: string) => fallback)

  const listen = <T extends Event>(
    target: EventTarget | null | undefined,
    event: string,
    listener: (event: T) => void,
  ) => {
    if (!target) return
    const handler = listener as EventListener
    target.addEventListener(event, handler)
    cleanups.push(() => target.removeEventListener(event, handler))
  }

  const query = <T extends Element>(selector: string) => root.querySelector<T>(selector)
  const queryAll = <T extends Element>(selector: string) => Array.from(root.querySelectorAll<T>(selector))
  const canvasHost = query<HTMLElement>('#freeform-canvas-host')
  const canvasRow = query<HTMLElement>('.freeform-canvas-row')
  const inspector = query<HTMLElement>('#freeform-element-inspector')
  const workspace = query<HTMLElement>('#freeform-designer-workspace')
  if (workspace) cleanups.push(bindDesignerTooltips(workspace))
  const fieldDrawer = bindFieldDrawer(root)
  let interactionRoot: HTMLElement | null = null
  let interactionGeneration = 0
  let imageSelectionElementId: string | null = null
  let selectedImageAssetId = ''
  let syncedInputs = new WeakMap<Element, string | number>()
  let inputSelection: string | null = null
  let inputReplacementVersion = controller.getReplacementVersion()
  const syncInputValue = (input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string | number) => {
    // Background refreshes keep active drafts; a new selection or model value wins.
    if (document.activeElement !== input || syncedInputs.get(input) !== value) {
      input.value = typeof value === 'number' ? formatDesignerNumber(value) : value
    }
    syncedInputs.set(input, value)
  }

  const syncGeometryLayout = () => {
    if (!canvasRow || !canvasHost) return
    const rowWidth = canvasRow.clientWidth
    const renderedLabelWidth = canvasHost.querySelector<HTMLElement>('.label-preview')?.getBoundingClientRect().width ?? 0
    const renderedLabelHeight = canvasHost.querySelector<HTMLElement>('.label-preview')?.getBoundingClientRect().height ?? 0
    const labelWidth = renderedLabelWidth || canvasHost.getBoundingClientRect().width
    if (rowWidth <= 0 || labelWidth <= 0) return
    canvasRow.style.setProperty('--freeform-label-width', `${labelWidth}px`)
    canvasHost.style.width = `${labelWidth}px`
    if (renderedLabelHeight > 0) canvasHost.style.height = `${renderedLabelHeight}px`
    const available = rowWidth - labelWidth - 8
    const below = available < 104
    canvasRow.classList.toggle('is-geometry-below', below)
    canvasRow.classList.toggle('is-geometry-narrow', !below && available < 170)
  }
  const geometryObserver = typeof MutationObserver === 'undefined' || !canvasHost
    ? null
    : new MutationObserver(syncGeometryLayout)
  if (geometryObserver && canvasHost) geometryObserver.observe(canvasHost, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true })
  if (geometryObserver) cleanups.push(() => geometryObserver.disconnect())
  if (canvasRow && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(syncGeometryLayout)
    observer.observe(canvasRow)
    cleanups.push(() => observer.disconnect())
  } else listen(window, 'resize', syncGeometryLayout)

  const syncQrReadability = () => {
    const recommendation = query<HTMLElement>('#freeform-qr-readability-recommendation')
    const warning = query<HTMLElement>('#freeform-qr-readability-warning')
    const note = query<HTMLElement>('#freeform-qr-readability-note')
    const readability = query<HTMLElement>('.freeform-qr-readability')
    const selected = controller.getSelectedElement()
    if (!recommendation || !warning) return
    if (readability) readability.hidden = selected?.type !== 'qr'
    const markDimension = (property: 'w' | 'h', undersized: boolean) => {
      const input = query<HTMLInputElement>(`#freeform-element-inspector [data-element-prop="${property}"]`)
      const label = input?.closest('label')
      const icon = label?.querySelector<HTMLElement>('[data-qr-size-warning]')
      label?.classList.toggle('is-qr-undersized', undersized)
      if (icon) icon.hidden = !undersized
      if (undersized) {
        input?.setAttribute('aria-invalid', 'true')
        input?.setAttribute('aria-describedby', 'freeform-qr-readability-recommendation freeform-qr-readability-warning')
      } else {
        input?.removeAttribute('aria-invalid')
        input?.removeAttribute('aria-describedby')
      }
    }
    if (note) {
      note.textContent = translate(
        'labelDesigner.qrReadabilityNote',
        'Keep {modules} modules of white clear space around the code and make a test print. This advisory does not guarantee scanning.',
      ).replace('{modules}', String(QR_QUIET_ZONE_MODULES))
    }
    if (selected?.type !== 'qr') {
      markDimension('w', false)
      markDimension('h', false)
      warning.hidden = true
      warning.textContent = ''
      return
    }
    const moduleCounts = queryAll<HTMLElement>('[data-qr-module-count]')
      .filter(node => node.dataset.labelElementId === selected.id)
      .map(node => Number(node.dataset.qrModuleCount))
      .filter(value => Number.isInteger(value) && value > 0)
    const recommendedMm = getQrRecommendedSideMm(moduleCounts.length ? Math.max(...moduleCounts) : undefined)
    if (recommendedMm === undefined) {
      markDimension('w', false)
      markDimension('h', false)
      recommendation.textContent = translate(
        'labelDesigner.qrReadabilityUnavailable',
        '{dpi} DPI size guidance appears after the code is rendered.',
      ).replace('{dpi}', String(QR_RECOMMENDED_DPI))
      warning.hidden = true
      warning.textContent = ''
      return
    }
    const formatted = formatDesignerNumber(recommendedMm)
    recommendation.textContent = translate(
      'labelDesigner.qrReadabilityRecommendation',
      'At {dpi} DPI, use at least {size} mm for this encoded QR.',
    ).replace('{dpi}', String(QR_RECOMMENDED_DPI)).replace('{size}', formatted)
    const undersized = selected.w < recommendedMm || selected.h < recommendedMm
    markDimension('w', selected.w < recommendedMm)
    markDimension('h', selected.h < recommendedMm)
    warning.textContent = undersized
      ? translate(
          'labelDesigner.qrReadabilityWarning',
          'This QR is below the recommended {size} mm at {dpi} DPI.',
        ).replace('{dpi}', String(QR_RECOMMENDED_DPI)).replace('{size}', formatted)
      : ''
    warning.hidden = !undersized
  }

  const syncDom = () => {
    const selectedId = controller.getSelectedId()
    const replacementVersion = controller.getReplacementVersion()
    if (inputSelection !== selectedId || inputReplacementVersion !== replacementVersion) {
      syncedInputs = new WeakMap()
      inputSelection = selectedId
      inputReplacementVersion = replacementVersion
    }
    const selected = controller.getSelectedElement()
    if (inspector) inspector.hidden = !selected

    queryAll<HTMLElement>('[data-element-section]').forEach(section => {
      section.hidden = section.dataset.elementSection !== selected?.type
    })
    queryAll<HTMLButtonElement>('[data-element-align], [data-element-vertical-align]').forEach(button => {
      const horizontal = button.dataset.elementAlign
      const horizontalElement = selected?.type === 'text' || selected?.type === 'manufacturerLogo'
      const active = horizontal
        ? horizontalElement && (selected.align ?? 'center') === horizontal
        : selected?.type === 'text' && (selected.verticalAlign ?? 'top') === button.dataset.elementVerticalAlign
      button.setAttribute('aria-pressed', String(active))
      button.disabled = !editable || (horizontal ? !horizontalElement : selected?.type !== 'text')
    })
    queryAll<HTMLButtonElement>('[data-element-toggle]').forEach(button => {
      const property = button.dataset.elementToggle
      const active = selected?.type === 'text' && (property === 'wrap' || property === 'fitToWidth')
        ? Boolean(selected[property])
        : false
      button.setAttribute('aria-pressed', String(active))
      button.disabled = !editable || selected?.type !== 'text'
    })
    queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-element-prop]').forEach(input => {
      const property = input.dataset.elementProp
      if (!selected || !property || !isElementProperty(property)) return
      const value: unknown = property === 'minFontSizeMm' && selected.type === 'text'
        ? selected.minFontSizeMm ?? (selected.wrap ? Math.min(2, selected.fontSizeMm) : 0.265)
        : Reflect.get(selected, property)
      if (input instanceof HTMLInputElement && input.type === 'radio') {
        input.checked = input.value === value
      } else if (typeof value === 'number' || typeof value === 'string') {
        syncInputValue(input, value)
      }
    })
    const fitSettings = query<HTMLDetailsElement>('#freeform-fit-settings')
    if (fitSettings && !(selected?.type === 'text' && selected.fitToWidth)) fitSettings.open = false
    const minimumSize = query<HTMLInputElement>('[data-element-prop="minFontSizeMm"]')
    if (minimumSize && selected?.type === 'text') minimumSize.max = String(selected.fontSizeMm)
    const fitWarning = query<HTMLElement>('#freeform-text-fit-warning')
    if (fitWarning) {
      const failed = selected?.type === 'text'
        ? queryAll<HTMLElement>('[data-label-output-error]').find(node => node.dataset.labelElementId === selected.id)
        : undefined
      fitWarning.hidden = !failed
      fitWarning.textContent = failed?.dataset.labelOutputError ?? ''
    }
    const json = query<HTMLTextAreaElement>('#freeform-element-json')
    const selectedJson = controller.getSelectedJson()
    // JSON is explicitly applied, so its draft survives focus leaving the textarea.
    if (json && syncedInputs.get(json) !== selectedJson) syncInputValue(json, selectedJson)
    const imageSelect = query<HTMLSelectElement>('#freeform-image-asset')
    if (imageSelect) {
      const current = selected?.type === 'image' ? selected.assetId : ''
      const selectedElementId = selected?.type === 'image' ? selected.id : null
      if (selectedElementId !== imageSelectionElementId) {
        imageSelectionElementId = selectedElementId
        selectedImageAssetId = current
      }
      if (selectedImageAssetId && !controller.getAssets().some(asset => asset.id === selectedImageAssetId)) {
        selectedImageAssetId = current
      }
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = translate('labelDesigner.chooseImage', 'Choose an image')
      placeholder.disabled = true
      imageSelect.replaceChildren(
        placeholder,
        ...controller.getAssets().map(asset => {
          const option = document.createElement('option')
          option.value = asset.id
          option.textContent = asset.display_name
          option.selected = asset.id === selectedImageAssetId
          return option
        }),
      )
      imageSelect.value = selectedImageAssetId
    }
    queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>([
      '[data-designer-add]',
      '[data-shape-menu-trigger]',
      '[data-designer-shape]',
      '[data-designer-action]',
      '[data-element-prop]',
      '[data-element-toggle]',
      '[data-field-token]',
      '#freeform-json-apply',
      '#freeform-image-upload',
      '#freeform-image-upload-trigger',
      '#freeform-image-apply',
      '#freeform-image-delete',
    ].join(',')).forEach(control => { control.disabled = !editable })
    queryAll<HTMLButtonElement>('[data-requires-selection]').forEach(button => { button.disabled = !editable || !selected })
    const deletingSelectedImage = controller.isAssetDeleting(selectedImageAssetId)
    const imageDelete = query<HTMLButtonElement>('#freeform-image-delete')
    if (imageDelete) imageDelete.disabled = !editable || deletingSelectedImage || selected?.type !== 'image' || !selectedImageAssetId
    const imageApply = query<HTMLButtonElement>('#freeform-image-apply')
    if (imageApply) imageApply.disabled = !editable || deletingSelectedImage || selected?.type !== 'image' || !selectedImageAssetId || selected.assetId === selectedImageAssetId
    const imageStatus = query<HTMLElement>('#freeform-image-status')
    if (imageStatus) imageStatus.textContent = controller.getState().assetError ?? ''
    queryAll<HTMLButtonElement>('[data-designer-action="undo"]').forEach(button => { button.disabled = !editable || !controller.canUndo() })
    queryAll<HTMLButtonElement>('[data-designer-action="redo"]').forEach(button => { button.disabled = !editable || !controller.canRedo() })
    canvasHost?.setAttribute('aria-readonly', String(!editable))
    if (workspace) workspace.dataset.editorEditable = String(editable)
    const data = options.getPreviewData?.()
    const colors = getFilamentSwatchColors(data?.['filament.color_hexes'], data?.['filament.color_hex'])
    const background = buildFilamentSwatchBackground(colors, data?.['filament.multi_color_style'])
    queryAll<HTMLElement>('[data-text-modifier="colorInverse"]').forEach(button => {
      button.classList.toggle('has-filament-color', Boolean(background))
      button.style.background = background
      button.style.borderColor = colors[0] ?? ''
      button.style.color = colors.length ? getReadableTextColorForColors(colors) : ''
    })
    for (const chrome of queryAll<HTMLElement>('.freeform-toolbar, #freeform-element-inspector, #freeform-field-dock')) {
      chrome.toggleAttribute('inert', !editable)
      chrome.toggleAttribute('aria-hidden', !editable)
    }
    fieldDrawer.update(selected?.type === 'text' ? selected.id : undefined, editable)
    syncGeometryLayout()
    queryAll<HTMLElement>('[data-label-element-id]').forEach(element => {
      element.classList.toggle('is-selected', editable && element.dataset.labelElementId === selectedId)
      const type = element.dataset.labelElementType as LabelElementType | undefined
      if (editable && type && type in elementLabelKeys) {
        element.tabIndex = 0
        element.setAttribute('role', 'button')
        element.setAttribute('aria-label', translate(elementLabelKeys[type], elementLabelFallbacks[type]))
      } else {
        element.removeAttribute('tabindex')
        element.removeAttribute('role')
        element.removeAttribute('aria-label')
      }
    })
    syncQrReadability()
    textEditor?.sync()
    cropEditor?.sync()
    interaction?.syncSelection()
  }

  const refreshInteraction = async () => {
    const canvas = canvasHost?.querySelector<HTMLElement>('.label-preview') ?? null
    if (!canvas || !editable) {
      interactionGeneration += 1
      interaction?.destroy()
      interaction = null
      interactionRoot = null
      return
    }
    if (interaction && interactionRoot === canvas) {
      interaction.refresh()
      return
    }
    interaction?.destroy()
    interaction = null
    interactionRoot = null
    const generation = ++interactionGeneration
    const isCurrent = () => generation === interactionGeneration
      && editable && !controller.isDestroyed()
      && canvas === canvasHost?.querySelector('.label-preview')
    const next = await bindLabelInteractions({
      root: canvas,
      getDesign: controller.getDesign,
      getSelectedId: controller.getSelectedId,
      getLabel: controller.getLabel,
      getElement: controller.getElement,
      getMaxZ: controller.getMaxZ,
      editable: true,
      onSelect: elementId => {
        controller.select(elementId)
        syncDom()
      },
      onGeometryChange: (elementId, geometry) => {
        controller.updateGesture(elementId, geometry)
        syncQrReadability()
        textEditor?.positionToolbar()
      },
      onGestureStart: () => {
        controller.beginGesture()
        textEditor?.setGestureActive(true)
      },
      onGestureEnd: elementId => {
        const changed = controller.endGesture()
        textEditor?.setGestureActive(false)
        syncDom()
        if (changed && controller.getElement(elementId)?.type !== 'shape') void refresh()
      },
      loadInteract: options.loadInteract,
      shouldInitialize: isCurrent,
    })
    if (!isCurrent()) {
      next.destroy()
      return
    }
    interaction = next
    interactionRoot = canvas
  }

  const refresh = async () => {
    await controller.requestRender()
    syncDom()
    await refreshInteraction()
    syncDom()
  }

  const focusElement = (elementId: string | null) => {
    const target = elementId
      ? canvasHost?.querySelector<HTMLElement>(`[data-label-element-id="${CSS.escape(elementId)}"]`)
      : null
    ;(target ?? canvasHost)?.focus()
  }

  const mutate = (operation: () => unknown, focusAfter?: 'selected' | 'canvas') => {
    if (!editable) return
    operation()
    syncDom()
    void refresh().then(() => {
      if (focusAfter === 'selected') focusElement(controller.getSelectedId())
      if (focusAfter === 'canvas') focusElement(null)
    })
  }

  const changeHistory = (direction: 'undo' | 'redo') => {
    if (!editable) return
    controller[direction]()
    textEditor.restoreHistorySelection()
  }

  queryAll<HTMLButtonElement>('[data-designer-add]').forEach(button => {
    listen<MouseEvent>(button, 'click', () => {
      const type = button.dataset.designerAdd as LabelElementType | undefined
      if (type) mutate(() => controller.addElement(type))
    })
  })

  const shapeMenu = bindShapeMenu(root)
  queryAll<HTMLButtonElement>('[data-designer-shape]').forEach(button => {
    listen<MouseEvent>(button, 'click', () => {
      const shape = LABEL_SHAPES.find(candidate => candidate === button.dataset.designerShape)
      if (editable && shape) mutate(() => controller.addElement('shape', shape), 'selected')
    })
  })

  queryAll<HTMLButtonElement>('[data-designer-action]').forEach(button => {
    listen<MouseEvent>(button, 'click', () => {
      switch (button.dataset.designerAction) {
        case 'undo': changeHistory('undo'); break
        case 'redo': changeHistory('redo'); break
        case 'duplicate': mutate(() => controller.duplicateSelected(), 'selected'); break
        case 'delete': mutate(() => controller.deleteSelected(), 'canvas'); break
        case 'forward': mutate(() => controller.moveSelected('forward')); break
        case 'back': mutate(() => controller.moveSelected('back')); break
      }
    })
  })

  queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-element-prop]').forEach(input => {
    listen<Event>(input, 'change', () => {
      if (!editable || (input instanceof HTMLInputElement && input.type === 'radio' && !input.checked)) return
      const property = input.dataset.elementProp
      if (!property || !isElementProperty(property)) return
      const numeric = ['x', 'y', 'w', 'h', 'fontSizeMm', 'minFontSizeMm', 'fontWeight', 'strokeWidthMm'].includes(property)
      syncedInputs.delete(input)
      mutate(() => controller.updateSelected({
        [property]: numeric ? Number(input.value) : input.value,
      } as Partial<LabelDesignElement>))
    })
  })

  const fontMenu = query<HTMLDetailsElement>('.freeform-font-menu')
  queryAll<HTMLButtonElement>('[data-font-choice]').forEach(button => {
    listen(button, 'click', () => {
      if (!editable) return
      const family = LABEL_FONT_FAMILIES.find(name => name === button.dataset.fontChoice)
      if (!family) return
      if (!textEditor.formatFont(family)) mutate(() => controller.updateSelected({ fontFamily: family }))
      if (fontMenu) fontMenu.open = false
    })
  })
  listen<PointerEvent>(document, 'pointerdown', event => {
    if (fontMenu?.open && event.target instanceof Node && !fontMenu.contains(event.target)) fontMenu.open = false
  })
  listen<KeyboardEvent>(fontMenu, 'keydown', event => {
    if (event.key === 'Escape') { fontMenu!.open = false; fontMenu!.querySelector('summary')?.focus() }
  })

  queryAll<HTMLButtonElement>('[data-element-align], [data-element-vertical-align]').forEach(button => {
    listen(button, 'click', () => {
      const align = button.dataset.elementAlign
      const verticalAlign = button.dataset.elementVerticalAlign
      const selected = controller.getSelectedElement()
      if ((selected?.type === 'text' || selected?.type === 'manufacturerLogo') && (align === 'left' || align === 'center' || align === 'right')) {
        mutate(() => controller.updateSelected({ align }))
      } else if (selected?.type === 'text' && (verticalAlign === 'top' || verticalAlign === 'middle' || verticalAlign === 'bottom')) {
        mutate(() => controller.updateSelected({ verticalAlign }))
      }
    })
  })

  queryAll<HTMLButtonElement>('[data-element-toggle]').forEach(button => {
    listen(button, 'click', () => {
      const selected = controller.getSelectedElement()
      const property = button.dataset.elementToggle
      if (selected?.type !== 'text' || (property !== 'wrap' && property !== 'fitToWidth')) return
      const active = !selected[property]
      mutate(() => controller.updateSelected({
        [property]: active,
        ...(property === 'fitToWidth' && active
          ? { minFontSizeMm: selected.minFontSizeMm ?? Math.min(2, selected.fontSizeMm) }
          : {}),
      }))
    })
  })

  cleanups.push(bindElementClipboard({
    canvas: canvasHost,
    isEditable: () => editable,
    getSelected: controller.getSelectedElement,
    paste: source => {
      const inserted = controller.pasteElement(source)
      if (!inserted) return false
      syncDom()
      void refresh().then(() => focusElement(inserted.id))
      return true
    },
  }))

  const template = query<HTMLTextAreaElement>('#freeform-template')
  const rememberTemplateSelection = () => {
    if (!template) return
    controller.setTemplateSelection(
      template.selectionStart ?? template.value.length,
      template.selectionEnd ?? template.value.length,
    )
  }
  listen(template, 'select', rememberTemplateSelection)
  listen(template, 'keyup', rememberTemplateSelection)
  listen(template, 'click', rememberTemplateSelection)

  const textEditor = bindCanvasTextEditor({
    root,
    getSelected: controller.getSelectedElement,
    getTemplateRange: controller.getTemplateSelection,
    setTemplateRange: range => controller.setTemplateSelection(range.start, range.end),
    resetTemplateRange: () => controller.setTemplateSelection(0, 0),
    isEditable: () => editable,
    select: id => {
      if (controller.getSelectedId() !== id) controller.select(id)
      syncDom()
    },
    updateTemplate: (value, range) => {
      controller.updateSelected({ template: value }, range)
    },
    undo: () => changeHistory('undo'),
    redo: () => changeHistory('redo'),
    refresh,
    refreshInteractions: refreshInteraction,
  })

  const cropEditor = bindImageCropEditor({
    root,
    controller,
    isEditable: () => editable,
    onChange: () => { syncDom(); void refresh() },
    translate,
  })

  listen<MouseEvent>(root as ParentNode & EventTarget, 'click', event => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[data-field-token]')
      : null
    if (!target || !root.contains(target)) return
    const token = target.dataset.fieldToken
    if (!token) return
    if (!editable) return
    if (!textEditor.insertField(token)) mutate(() => controller.insertField(token))
  })

  const fieldTabs = queryAll<HTMLButtonElement>('[data-field-group-tab]').filter(button => !button.hidden)
  const activateFieldTab = (button: HTMLButtonElement) => {
    const group = button.dataset.fieldGroupTab
    fieldTabs.forEach(candidate => {
      const active = candidate === button
      candidate.setAttribute('aria-selected', String(active))
      candidate.tabIndex = active ? 0 : -1
    })
    queryAll<HTMLElement>('[data-field-group]').forEach(panel => {
      panel.hidden = panel.dataset.fieldGroup !== group
    })
  }
  fieldTabs.forEach(button => {
    listen<MouseEvent>(button, 'click', () => activateFieldTab(button))
    listen<KeyboardEvent>(button, 'keydown', event => {
      const current = fieldTabs.indexOf(button)
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? fieldTabs.length - 1
          : event.key === 'ArrowRight'
            ? (current + 1) % fieldTabs.length
            : event.key === 'ArrowLeft'
              ? (current - 1 + fieldTabs.length) % fieldTabs.length
              : -1
      if (next < 0) return
      event.preventDefault()
      activateFieldTab(fieldTabs[next])
      fieldTabs[next].focus()
    })
  })

  const json = query<HTMLTextAreaElement>('#freeform-element-json')
  const jsonError = query<HTMLElement>('#freeform-json-error')
  listen<MouseEvent>(query('#freeform-json-apply'), 'click', () => {
    if (!editable) return
    const result = controller.applySelectedJson(json?.value ?? '')
    if (jsonError) jsonError.textContent = result.error ?? ''
    if (result.ok) json?.removeAttribute('aria-invalid')
    else json?.setAttribute('aria-invalid', 'true')
    if (result.ok) {
      if (json) syncedInputs.delete(json)
      syncDom()
      void refresh()
    }
  })
  listen<MouseEvent>(query('#freeform-json-revert'), 'click', () => {
    if (json) json.value = controller.getSelectedJson()
    if (jsonError) jsonError.textContent = ''
    json?.removeAttribute('aria-invalid')
  })
  const upload = query<HTMLInputElement>('#freeform-image-upload')
  const imageSelect = query<HTMLSelectElement>('#freeform-image-asset')
  listen<Event>(imageSelect, 'change', () => {
    selectedImageAssetId = imageSelect?.value ?? ''
    syncDom()
  })
  listen<MouseEvent>(query('#freeform-image-apply'), 'click', () => {
    if (!editable || !selectedImageAssetId || controller.isAssetDeleting(selectedImageAssetId) || controller.getSelectedElement()?.type !== 'image') return
    mutate(() => controller.updateSelected({ assetId: selectedImageAssetId }))
  })
  listen<MouseEvent>(query('#freeform-image-upload-trigger'), 'click', () => {
    if (editable && controller.getSelectedElement()?.type === 'image') upload?.click()
  })
  listen<Event>(upload, 'change', () => {
    if (!editable) return
    const file = upload?.files?.[0]
    if (!file) return
    const target = controller.getSelectedElement()
    if (target?.type !== 'image') return
    const finishUpload = controller.beginImageUpload(target.id)
    void controller.uploadAsset(file).then(asset => {
      if (controller.isDestroyed() || !editable) return
      if (finishUpload()) {
        if (controller.getSelectedId() === target.id) selectedImageAssetId = asset.id
        controller.updateElement(target.id, { assetId: asset.id })
        void refresh()
      }
      const status = query<HTMLElement>('#freeform-image-status')
      if (status) status.textContent = ''
      syncDom()
    }).catch(error => {
      const status = query<HTMLElement>('#freeform-image-status')
      if (status) status.textContent = localizedErrorMessage(
        error,
        translate,
        'labelDesigner.imageUploadFailed',
        'Upload failed',
      )
    }).finally(() => {
      finishUpload()
      if (upload) upload.value = ''
    })
  })
  listen<MouseEvent>(query('#freeform-image-delete'), 'click', () => {
    if (!editable) return
    if (controller.getSelectedElement()?.type !== 'image' || !selectedImageAssetId) return
    const assetId = selectedImageAssetId
    void controller.deleteAsset(assetId).then(() => {
      if (selectedImageAssetId === assetId) selectedImageAssetId = ''
      syncDom()
    }).catch(error => {
      syncDom()
      const status = query<HTMLElement>('#freeform-image-status')
      if (status) status.textContent = localizedErrorMessage(
        error,
        translate,
        'labelDesigner.imageDeleteFailed',
        'Delete failed',
      )
    })
    syncDom()
  })

  listen<KeyboardEvent>(canvasHost, 'keydown', event => {
    if (!editable) return
    if (textEditor?.handleKeydown(event)) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
    const element = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-label-element-id]')
      : null
    if ((event.key === 'Enter' || event.key === ' ') && element?.dataset.labelElementId) {
      event.preventDefault()
      controller.select(element.dataset.labelElementId)
      syncDom()
      return
    }
    const step = event.shiftKey ? 1 : 0.1
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      mutate(() => controller.duplicateSelected(), 'selected')
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      mutate(() => controller.deleteSelected(), 'canvas')
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault()
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      mutate(() => controller.nudgeSelected(dx, dy), 'selected')
    }
  })
  listen<KeyboardEvent>(workspace ?? canvasHost, 'keydown', event => {
    if (!editable || !(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key !== 'z' && key !== 'y') return
    const target = event.target instanceof Element ? event.target : null
    if (target && !target.closest('[data-label-text-editing]')
      && target.closest('input, textarea, select, [contenteditable]')) return
    event.preventDefault()
    changeHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo')
  })
  listen<FocusEvent>(canvasHost, 'focusin', event => {
    if (!editable) return
    const element = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-label-element-id]')
      : null
    if (!element?.dataset.labelElementId) return
    if (controller.getSelectedId() !== element.dataset.labelElementId) controller.select(element.dataset.labelElementId)
    syncDom()
  })
  listen<MouseEvent>(canvasHost, 'click', event => {
    if (!editable) return
    const frame = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-label-selection-for]')
      : null
    if (frame?.dataset.labelSelectionFor) focusElement(frame.dataset.labelSelectionFor)
  })

  // Dismiss on the initial press, not release, so dragging outside the label
  // still finishes normally. Inspector and formatting controls retain selection.
  listen<PointerEvent>(canvasHost?.ownerDocument, 'pointerdown', event => {
    if (!editable || !controller.getSelectedId() || !(event.target instanceof Element)) return
    const target = event.target
    if (canvasHost?.contains(target) && target.closest('[data-label-element-id], [data-label-selection-for]')) return
    const editingControl = target.closest('.freeform-command-bar, .freeform-toolbar, #freeform-element-inspector, #freeform-field-dock, .freeform-text-toolbar, .freeform-shape-menu')
    if (editingControl && root.contains(editingControl)) return
    const selection = canvasHost?.ownerDocument.getSelection()
    if (selection?.anchorNode && canvasHost?.contains(selection.anchorNode)) selection.removeAllRanges()
    const focused = canvasHost?.ownerDocument.activeElement
    if (focused instanceof HTMLElement && canvasHost?.contains(focused)) focused.blur()
    controller.clearSelection()
    syncDom()
  })

  syncDom()
  const ready = refresh()
  void controller.loadAssets().then(syncDom).catch(() => syncDom())

  return {
    ready,
    refresh,
    async refreshInteractions() {
      await refreshInteraction()
      syncDom()
    },
    sync: syncDom,
    async setEditable(next: boolean) {
      editable = next
      syncDom()
      await refreshInteraction()
      syncDom()
    },
    destroy() {
      interactionGeneration += 1
      textEditor?.destroy()
      fieldDrawer.destroy()
      cropEditor?.destroy()
      shapeMenu.destroy()
      interaction?.destroy()
      cleanups.splice(0).forEach(cleanup => cleanup())
      controller.destroy()
    },
  }
}
