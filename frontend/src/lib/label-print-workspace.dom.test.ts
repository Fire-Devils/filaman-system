// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBatchLabelPreviewRuntime, createSingleLabelPreviewRuntime } from './label-print-workspace'
import { appendLabelSettingsCheckbox, createPrintWorkspaceCoordinator, type PrintLabelSource } from './label-print-page'
import { renderLabelSheetPreview, restoreIndividualLabelPreview } from './label-sheet'

describe('single label preview runtime', () => {
  let label: HTMLElement
  let source: PrintLabelSource

  beforeEach(() => {
    document.body.innerHTML = '<div id="label">old</div>'
    label = document.getElementById('label')!
    source = 'standard'
  })

  function createRuntime(overrides: Partial<Parameters<typeof createSingleLabelPreviewRuntime>[0]> = {}) {
    return createSingleLabelPreviewRuntime({
      label,
      getSource: () => source,
      renderStandard: () => { label.textContent = 'standard' },
      renderDesigner: () => { label.textContent = 'designer' },
      getStandardDimensions: () => ({ widthMm: 60, heightMm: 30 }),
      getDesignerDimensions: () => ({ widthMm: 70, heightMm: 40 }),
      ...overrides,
    })
  }

  it('resets styles and lets the renderer replace the selected source', () => {
    const renderStandard = vi.fn(() => {
      expect(label.innerHTML).toBe('old')
      expect(label.style.borderStyle).toBe('none')
      expect(label.style.padding).toBe('')
      label.textContent = 'standard'
    })
    const runtime = createRuntime({ renderStandard })

    runtime.refresh()
    expect(renderStandard).toHaveBeenCalledOnce()
    expect(label.textContent).toBe('standard')

    source = 'designer'
    runtime.activate()
    expect(label.textContent).toBe('designer')
    expect(label.style.border).toBe('')
  })

  it('keeps the focused editor available until an asynchronous render completes', async () => {
    source = 'designer'
    const input = document.createElement('div')
    input.contentEditable = 'true'
    input.tabIndex = 0
    input.textContent = 'ABC'
    label.replaceChildren(input)
    input.focus()
    let finish!: () => void
    const runtime = createRuntime({ renderDesigner: () => new Promise<void>(resolve => { finish = resolve }) })

    const pending = runtime.refresh()
    expect(document.activeElement).toBe(input)
    expect(label.textContent).toBe('ABC')
    finish()
    await pending
  })

  it('returns dimensions for the selected source', () => {
    const runtime = createRuntime()
    expect(runtime.getDimensions()).toEqual({ widthMm: 60, heightMm: 30 })
    source = 'designer'
    expect(runtime.getDimensions()).toEqual({ widthMm: 70, heightMm: 40 })
  })

  it('ignores completion of a superseded render', async () => {
    let finish!: () => void
    const runtime = createRuntime({
      renderStandard: stale => new Promise<void>(resolve => {
        finish = () => {
          if (!stale()) label.textContent = 'old'
          resolve()
        }
      }),
      renderDesigner: stale => { if (!stale()) label.textContent = 'new' },
    })

    runtime.refresh()
    source = 'designer'
    runtime.activate()
    finish()
    await Promise.resolve()

    expect(label.textContent).toBe('new')
  })
})

describe('batch label preview runtime', () => {
  it('keeps the visible editor target through sheet round trips and subsequent navigation', async () => {
    document.body.innerHTML = '<main><div id="canvas"><div id="one"><div class="label-preview">one</div></div><div id="two"><div class="label-preview">two</div></div><div id="three"><div class="label-preview">three</div></div></div></main>'
    const root = document.querySelector('main')!
    const canvas = document.querySelector('#canvas')!
    const wrappers = Array.from(canvas.children) as HTMLElement[]
    const workspace = createPrintWorkspaceCoordinator({
      initialMode: 'designer', getItems: () => wrappers,
      getSheetSource: () => ({ type: 'standard' }), onModeChange: () => undefined,
    })
    const runtime = createBatchLabelPreviewRuntime({
      getActiveMode: workspace.getActiveMode, getPreviewIndex: workspace.getPreviewIndex,
      getWorkspaceState: workspace.getState, getDesign: () => null,
      findElement: wrapper => wrapper, getSourceElements: () => wrappers,
      renderStandard: async () => undefined, renderDesigner: async () => undefined,
      afterRender: state => {
        if (state.mode === 'sheets') renderLabelSheetPreview({
          previewRoot: root, sourceElements: wrappers, labelWidthMm: 60, labelHeightMm: 40,
          settings: {
            paperSize: 'custom', customWidthMm: 180, customHeightMm: 40, rows: 1, columns: 3,
            marginTopMm: 0, marginRightMm: 0, marginBottomMm: 0, marginLeftMm: 0,
            gapHorizontalMm: 0, gapVerticalMm: 0, skipCells: 0, copies: 1,
            showGrid: false, printGrid: false, fitToCell: false,
          },
        })
        else restoreIndividualLabelPreview(root, wrappers)
      },
    })
    workspace.selectPreview(1)
    await runtime.render()
    expect(canvas.querySelector('.label-preview')?.textContent).toBe('two')
    for (const selected of [1, 2, 0]) {
      workspace.activate('sheets')
      await runtime.render()
      expect(root.querySelectorAll('.label-sheet-cell .label-preview')).toHaveLength(3)
      workspace.activate('designer')
      workspace.selectPreview(selected)
      await runtime.render()
      const first = canvas.querySelector('.label-preview')!
      expect(first.parentElement).toBe(wrappers[selected])
      expect(first.parentElement?.classList.contains('is-designer-output-only')).toBe(false)
      await runtime.render('designer', true)
      expect(canvas.firstElementChild).toBe(wrappers[selected])
    }
    workspace.activate('standard')
    await runtime.render()
    expect(Array.from(canvas.children).map(element => element.id)).toEqual(['one', 'two', 'three'])
  })

  it('checks cancellation without rebuilding the full item snapshot for every element', async () => {
    const items = [1, 2, 3]
    const workspace = createWorkspace(items)
    const elements = createElements(items)
    let snapshots = 0
    const rendered: number[] = []
    const runtime = createBatchLabelPreviewRuntime({
      getActiveMode: workspace.getActiveMode,
      getPreviewIndex: workspace.getPreviewIndex,
      getWorkspaceState: mode => { snapshots++; return workspace.getState(mode) },
      getDesign: () => null,
      findElement: item => elements.get(item)!,
      renderStandard: async () => undefined,
      renderDesigner: async (_element, item, _interactive, _design, stale) => {
        for (let element = 0; element < 20; element++) {
          if (stale()) return
        }
        rendered.push(item)
      },
      getSourceElements: () => [...elements.values()],
      afterRender: () => undefined,
    })

    await runtime.render('designer', true)
    expect(rendered).toEqual(items)
    expect(snapshots).toBe(1)
  })

  it('rerenders batch labels when an extra-field checkbox changes', async () => {
    const items = [1, 2]
    const workspace = createWorkspace(items, 'standard')
    const elements = createElements(items)
    const runtime = createBatchLabelPreviewRuntime({
      getActiveMode: workspace.getActiveMode,
      getPreviewIndex: workspace.getPreviewIndex,
      getWorkspaceState: workspace.getState,
      getDesign: () => null,
      findElement: item => elements.get(item)!,
      renderStandard: async element => { element.textContent = checkbox.checked ? 'Extra field' : '' },
      renderDesigner: async () => undefined,
      getSourceElements: () => [...elements.values()],
      afterRender: () => undefined,
    })
    const checkbox = appendLabelSettingsCheckbox({
      container: document.body, label: 'Extra field', checked: false,
      onChange: runtime.render,
    })
    await runtime.render()
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    expect([...elements.values()].map(element => element.textContent)).toEqual(['Extra field', 'Extra field'])
  })

  function createWorkspace(items: number[], mode: 'standard' | 'designer' = 'designer') {
    return createPrintWorkspaceCoordinator({
      initialMode: mode,
      getItems: () => items,
      getSheetSource: () => ({ type: 'standard' }),
      onModeChange: () => undefined,
    })
  }

  function createElements(items: number[]) {
    return new Map(items.map(item => {
      const element = document.createElement('div')
      document.body.append(element)
      return [item, element]
    }))
  }

  it('dispatches preview and output items with one interactive designer representative', async () => {
    const items = [1, 2, 3]
    const workspace = createWorkspace(items)
    const elements = createElements(items)
    const standard: number[] = []
    const designer: Array<[number, boolean, string]> = []
    const afterRender = vi.fn()
    const runtime = createBatchLabelPreviewRuntime({
      getActiveMode: workspace.getActiveMode,
      getPreviewIndex: workspace.getPreviewIndex,
      getWorkspaceState: workspace.getState,
      getDesign: () => 'design',
      findElement: item => elements.get(item)!,
      renderStandard: async (_element, item) => { standard.push(item) },
      renderDesigner: async (_element, item, interactive, design) => { designer.push([item, interactive, design]) },
      getSourceElements: () => [...elements.values()],
      afterRender,
    })

    await runtime.render()
    expect(designer).toEqual([[1, true, 'design']])
    expect(elements.get(2)!.classList).toContain('is-designer-output-only')

    designer.length = 0
    await runtime.render('designer', true)
    expect(designer).toEqual([[1, true, 'design'], [2, false, 'design'], [3, false, 'design']])

    workspace.activate('standard')
    await runtime.render()
    expect(standard).toEqual(items)
    expect(afterRender).toHaveBeenCalledTimes(3)
  })

  it('yields between six-item chunks', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7]
    const workspace = createWorkspace(items, 'standard')
    const elements = createElements(items)
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const rendered: number[] = []
    const runtime = createBatchLabelPreviewRuntime({
      getActiveMode: workspace.getActiveMode,
      getPreviewIndex: workspace.getPreviewIndex,
      getWorkspaceState: workspace.getState,
      getDesign: () => null,
      findElement: item => elements.get(item)!,
      renderStandard: async (_element, item) => { rendered.push(item) },
      renderDesigner: async () => undefined,
      getSourceElements: () => [...elements.values()],
      afterRender: () => undefined,
    })

    await runtime.render()
    expect(rendered).toEqual(items)
    expect(timeout).toHaveBeenCalledTimes(1)
    timeout.mockRestore()
  })

  it('invalidates slow renders after preview-index and mode changes', async () => {
    const items = [1, 2]
    const workspace = createWorkspace(items)
    const elements = createElements(items)
    const committed: number[] = []
    let finish!: () => void
    const runtime = createBatchLabelPreviewRuntime({
      getActiveMode: workspace.getActiveMode,
      getPreviewIndex: workspace.getPreviewIndex,
      getWorkspaceState: workspace.getState,
      getDesign: () => null,
      findElement: item => elements.get(item)!,
      renderStandard: async () => undefined,
      renderDesigner: (_element, item, _interactive, _design, stale) => new Promise<void>(resolve => {
        finish = () => {
          if (!stale()) committed.push(item)
          resolve()
        }
      }),
      getSourceElements: () => [...elements.values()],
      afterRender: () => undefined,
    })

    const indexRender = runtime.render()
    workspace.selectPreview(1)
    finish()
    await indexRender

    const modeRender = runtime.render()
    workspace.activate('standard')
    finish()
    await modeRender

    expect(committed).toEqual([])
  })
})
