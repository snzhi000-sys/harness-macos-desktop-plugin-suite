import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/ExplorerView.tsx', 'utf8')
const styles = readFileSync('src/client/sidebar.module.css', 'utf8')

describe('Explorer rename layout', () => {
  it('cannot horizontally scroll the tree when the rename input receives focus', () => {
    expect(source).toContain('input.focus({ preventScroll: true })')
    expect(source).toContain('event.currentTarget.scrollLeft = 0')
    expect(styles).toMatch(/\.explorerBody\s*\{[\s\S]*?overflow-x:\s*hidden;/)
    expect(styles).toMatch(/\.explorerRenameInput\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?flex:\s*1 1 0;/)
  })

  it('adds one isolated Finder reveal action without changing existing menu actions', () => {
    expect(source).toContain("{ id: 'reveal-finder', label: t('revealInFinder'), icon: <IconFolderOpenOutline16 size={14} /> }")
    expect(source).toContain("if (id === 'reveal-finder')")
    expect(source).toContain('void revealInFinder(target.path)')
    expect(source).toContain("{ id: 'reference', label: t('reference')")
    expect(source).toContain("{ id: 'relative', label: t('copyRelative')")
    expect(source).toContain("{ id: 'absolute', label: t('copyAbsolute')")
    expect(source).toContain("{ id: 'delete', label: t('delete')")
  })

  it('keeps the uncommon visibility toggle beside the folder-collapse action', () => {
    const visibilityAt = source.indexOf("<Tooltip label={t('toggleUncommonVisibility')}")
    const collapseAt = source.indexOf("<Tooltip label={t('collapseAllFolders')}")
    expect(visibilityAt).toBeGreaterThan(-1)
    expect(collapseAt).toBeGreaterThan(visibilityAt)
    expect(source).toContain("id: 'toggle-uncommon'")
    expect(source).toContain('!visibility.hideUncommon || !uncommon.has(entry.path)')
    expect(styles).toMatch(/\.explorerVisibilityToggleActive\s*\{[\s\S]*?interactive-bg-active/)
  })
})
