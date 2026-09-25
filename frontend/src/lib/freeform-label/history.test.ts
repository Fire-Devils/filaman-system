import { describe, expect, it } from 'vitest'

import { createLabelHistory } from './history'

describe('label designer history', () => {
  it('supports undo, redo, and discards redo after a new change', () => {
    const history = createLabelHistory({ value: 0 })
    history.push({ value: 1 })
    history.push({ value: 2 })

    expect(history.undo()).toEqual({ value: 1 })
    expect(history.undo()).toEqual({ value: 0 })
    expect(history.redo()).toEqual({ value: 1 })
    history.push({ value: 9 })

    expect(history.current()).toEqual({ value: 9 })
    expect(history.canRedo()).toBe(false)
  })

  it('retains at most fifty undo snapshots and resets for a loaded preset', () => {
    const history = createLabelHistory({ value: 0 }, 50)
    for (let value = 1; value <= 60; value += 1) history.push({ value })

    let undoCount = 0
    while (history.canUndo()) {
      history.undo()
      undoCount += 1
    }
    expect(undoCount).toBe(50)
    expect(history.current()).toEqual({ value: 10 })

    history.reset({ value: 100 })
    expect(history.current()).toEqual({ value: 100 })
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
  })

  it('clones snapshots so callers cannot mutate stored history', () => {
    const initial = { nested: { value: 1 } }
    const history = createLabelHistory(initial)
    initial.nested.value = 8

    expect(history.current()).toEqual({ nested: { value: 1 } })
    const current = history.current()
    current.nested.value = 9
    expect(history.current()).toEqual({ nested: { value: 1 } })
  })

  it('amends selection without adding an undo step or discarding redo', () => {
    const history = createLabelHistory({ value: 0, selection: { start: 0 } })
    history.push({ value: 1, selection: { start: 3 } })
    history.undo()
    const selection = { start: 2 }
    history.amend({ selection })
    selection.start = 9
    expect(history.current()).toEqual({ value: 0, selection: { start: 2 } })
    expect(history.canUndo()).toBe(false)
    expect(history.redo()).toEqual({ value: 1, selection: { start: 3 } })
    expect(history.undo()).toEqual({ value: 0, selection: { start: 2 } })
  })
})
