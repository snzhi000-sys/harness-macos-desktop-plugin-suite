/** Editable level thresholds are global pet preferences; the displayed score belongs to the current chat. */
import { validateIntimacyLevels } from './intimacy.mjs'
export function mountIntimacySettings(root) {
  root.innerHTML = `<h3>亲密度</h3><p data-intimacy-status role="status">正在读取…</p><p>每完成一轮用户消息与 AI 回复加 1 分；失败、中断和测试连接不计分。新建对话从 0 开始，已有历史不补算。</p><p>自由填写每级的起始分数、结束分数与等级名称，两端分数都包含在内。区间从 0 开始连续排列，不可重叠；最后一级结束分数留空表示无上限。在情绪模拟 Prompt 中插入 {{亲密情况}} 后生效。</p><div data-intimacy-levels></div><button data-add-level>添加等级</button>`
  const list = root.querySelector('[data-intimacy-levels]')
  const rows = () => [...list.children]
  const add = level => {
    const row = document.createElement('fieldset'); row.style.cssText = 'border:1px solid #dfe3ea;border-radius:12px;padding:16px;margin:12px 0'
    row.innerHTML = `<label>等级名称<input data-level-name></label><div style="display:flex;gap:12px"><label style="flex:1">起始分数<input data-min type="number" min="0" step="1"></label><label style="flex:1">结束分数<input data-max type="number" min="0" step="1" placeholder="最后一级留空，不限上限"></label></div><label>亲密情况描述<textarea data-level-description></textarea></label><button data-remove-level>删除等级</button>`
    row.querySelector('[data-level-name]').value = level.name; row.querySelector('[data-min]').value = level.min; row.querySelector('[data-level-description]').value = level.description
    row.querySelector('[data-max]').value = level.max ?? ''
    row.querySelector('[data-remove-level]').onclick = e => { e.preventDefault(); row.remove() }
    list.append(row)
  }
  root.querySelector('[data-add-level]').onclick = e => { e.preventDefault(); const last = rows().at(-1); if (last && last.querySelector('[data-max]').value === '') last.querySelector('[data-max]').value = Number(last.querySelector('[data-min]').value)+9; add({ min: last ? Number(last.querySelector('[data-max]').value)+1 : 0, max: null, name: `${rows().length+1}级`, description: '' }) }
  return {
    load(levels) { list.replaceChildren(); levels.forEach(add) },
    state(value) { root.querySelector('[data-intimacy-status]').textContent = value ? `当前对话：${value.score} 分 · ${value.name}` : '当前对话：0 分' },
    value() { return validateIntimacyLevels(rows().map(row => ({ min: row.querySelector('[data-min]').value === '' ? NaN : Number(row.querySelector('[data-min]').value), max: row.querySelector('[data-max]').value === '' ? null : Number(row.querySelector('[data-max]').value), name: row.querySelector('[data-level-name]').value, description: row.querySelector('[data-level-description]').value }))) },
  }
}
