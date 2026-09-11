/** Scrollable built-in character navigation with one outstanding switch at a time. */
export function mountModelManager(container, { wardrobe, api, selected, select, status }) {
  container.innerHTML = '<label class="search-label" for="model-search">选择伙伴</label><input id="model-search" type="search" aria-label="搜索角色" placeholder="搜索角色名称"><p id="library-count"></p><div id="models" role="group" aria-label="内置角色列表"></div>'
  const find = id => container.querySelector(`#${id}`)
  let models = [], active = false, disposed = false, switching = false, revision = 0
  const remembered = new Map()
  const choose = async model => {
    if (!active || disposed || switching || selected() === model.id) return
    switching = true; render()
    try { await select(model); remembered.set(model.characterId, model.id); if (!disposed && active) status(`已切换为 ${model.name}`) }
    catch (error) { if (!disposed) status(error.message) }
    finally { switching = false; if (!disposed) render() }
  }
  const render = () => {
    const scrollTop = find('models').scrollTop
    const query = find('model-search').value.trim().toLowerCase()
    const groups = new Map()
    for (const model of models) { if (!groups.has(model.characterId)) groups.set(model.characterId, []); groups.get(model.characterId).push(model) }
    const filtered = [...groups.values()].filter(variants => variants.some(model => `${model.name} ${model.subtitle} ${model.characterName} ${model.outfitName}`.toLowerCase().includes(query)))
    find('library-count').textContent = query ? `找到 ${filtered.length} / ${groups.size} 位伙伴` : `${groups.size} 位伙伴 · ${models.length} 套造型`
    find('models').replaceChildren()
    for (const variants of filtered) {
      const model = variants.find(m => m.id === selected()) ?? variants.find(m => m.id === remembered.get(m.characterId)) ?? variants[0]
      const button = document.createElement('button')
      button.className = 'character-row'; button.dataset.modelId = model.id
      button.setAttribute('aria-pressed', String(selected() === model.id)); button.disabled = switching
      const image = document.createElement('img'); image.src = model.thumbnail; image.alt = ''; image.loading = 'lazy'
      const text = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small')
      name.textContent = model.characterName; detail.textContent = model.subtitle + (variants.length > 1 ? ` · ${variants.length} 套服装` : ''); text.append(name, detail)
      const marker = document.createElement('span'); marker.className = 'selection-mark'; marker.textContent = selected() === model.id ? '✓' : ''
      button.append(image, text, marker)
      button.onclick = () => choose(model)
      find('models').append(button)
    }
    if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '没有找到这个角色，试试其他名字。'; find('models').append(empty) }
    find('models').scrollTop = scrollTop
    wardrobe.replaceChildren()
    const current = models.find(model => model.id === selected()), variants = groups.get(current?.characterId) ?? []
    if (variants.length > 1) {
      const label = document.createElement('label'); label.textContent = '服装 '; label.htmlFor = 'pet-outfit'
      const picker = document.createElement('select'); picker.id = 'pet-outfit'; picker.disabled = switching; picker.style.cssText = 'font:inherit;padding:6px;margin:0 0 12px;border:1px solid #e0e4ec;border-radius:8px;max-width:100%'
      for (const model of variants) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.outfitName; picker.append(option) }
      picker.value = current.id; picker.onchange = () => choose(variants.find(model => model.id === picker.value))
      wardrobe.append(label, picker)
    }
  }
  find('model-search').oninput = render
  return {
    async refresh() { const token = ++revision; const value = await api('models'); if (disposed || !active || token !== revision) return; models = value; render(); return models.find(model => model.id === selected()) },
    resume() { active = true; find('model-search').value = '' },
    suspend() { active = false; ++revision },
    dispose() { disposed = true; active = false; ++revision; container.replaceChildren(); wardrobe.replaceChildren() },
  }
}
