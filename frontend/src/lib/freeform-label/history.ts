export function createLabelHistory<T>(initial: T, maxUndoSnapshots = 50) {
  const limit = Math.max(1, Math.floor(maxUndoSnapshots))
  let snapshots = [structuredClone(initial)]
  let index = 0
  const copyCurrent = () => structuredClone(snapshots[index])

  const pushSnapshot = (value: T) => {
    if (JSON.stringify(snapshots[index]) === JSON.stringify(value)) return
    snapshots = snapshots.slice(0, index + 1)
    snapshots.push(structuredClone(value))
    if (snapshots.length > limit + 1) snapshots.shift()
    index = snapshots.length - 1
  }

  return {
    current: copyCurrent,
    push: pushSnapshot,
    amend(value: Partial<T>) {
      snapshots[index] = { ...snapshots[index], ...structuredClone(value) }
    },
    undo() {
      if (index > 0) index -= 1
      return copyCurrent()
    },
    redo() {
      if (index < snapshots.length - 1) index += 1
      return copyCurrent()
    },
    canUndo: () => index > 0,
    canRedo: () => index < snapshots.length - 1,
    reset(value: T) {
      snapshots = [structuredClone(value)]
      index = 0
    },
  }
}
