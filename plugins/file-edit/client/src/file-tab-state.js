export function closeProcessedTabState(tabs, active, pendingPaths, dirtyPaths) {
  const currentTabs = Array.isArray(tabs) ? tabs.slice() : []
  const pending = new Set(pendingPaths || [])
  const dirty = new Set(dirtyPaths || [])
  const kept = currentTabs.filter((path) => pending.has(path) || dirty.has(path))
  const closed = currentTabs.filter((path) => !pending.has(path) && !dirty.has(path))

  if (kept.includes(active)) return { tabs: kept, active: active, closed: closed }
  if (kept.length === 0) return { tabs: kept, active: null, closed: closed }

  const activeIndex = currentTabs.indexOf(active)
  if (activeIndex >= 0) {
    for (let i = activeIndex + 1; i < currentTabs.length; i++) {
      if (kept.includes(currentTabs[i])) return { tabs: kept, active: currentTabs[i], closed: closed }
    }
    for (let i = activeIndex - 1; i >= 0; i--) {
      if (kept.includes(currentTabs[i])) return { tabs: kept, active: currentTabs[i], closed: closed }
    }
  }
  return { tabs: kept, active: kept[kept.length - 1], closed: closed }
}
