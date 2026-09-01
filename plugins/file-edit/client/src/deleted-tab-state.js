export function markDeletedTabState(current, openTabs, path) {
  const next = new Set(current || [])
  if (!path) return next
  next.add(path)
  const inside = (value) => value === path || value.startsWith(path + '/') || value.startsWith(path + '\\')
  for (const value of openTabs || []) if (inside(value)) next.add(value)
  return next
}

export function clearDeletedTabState(current, path) {
  const next = new Set(current || [])
  if (path) next.delete(path)
  return next
}
