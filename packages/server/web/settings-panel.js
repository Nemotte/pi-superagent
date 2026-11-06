const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
export function mergeDraft(base, local, remote, path = '') {
  if (equal(local, base)) return { value: remote, conflicts: [] }
  if (equal(remote, base) || equal(local, remote)) return { value: local, conflicts: [] }
  if (object(base) && object(local) && object(remote)) {
    const value = {}, conflicts = []
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const result = mergeDraft(base[key], local[key], remote[key], path ? `${path}.${key}` : key)
      Object.defineProperty(value, key, { value: result.value, enumerable: true, configurable: true, writable: true }); conflicts.push(...result.conflicts)
    }
    return { value, conflicts }
  }
  return { value: local, conflicts: [path] }
}
export function createSettingsPanel({ $, api, text, button, safe, refresh }) {
  let base, loading, dirty = false, saving = false, catalog
  const controls = () => [...$('config-view').querySelectorAll('input,select,textarea,button')]
  const mark = () => { dirty = true; $('settings-notice').textContent = '有未保存的修改。'; $('settings-save').disabled = false }
  function ruleRow(rule) {
    const row = text('fieldset', ''); row.className = 'rule-row'
    const id = document.createElement('input'); id.value = rule.id; id.maxLength = 64; id.required = true; id.pattern = '[a-z0-9_-]{1,64}'; id.setAttribute('aria-label', '规则 ID'); id.dataset.field = 'id'
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled; enabled.dataset.field = 'enabled'
    const enableLabel = text('label', '启用此规则'); enableLabel.className = 'check'; enableLabel.prepend(enabled)
    const instruction = document.createElement('textarea'); instruction.value = rule.instruction; instruction.required = true; instruction.maxLength = 4000; instruction.setAttribute('aria-label', '规则说明'); instruction.dataset.field = 'instruction'
    row.append(text('label', '规则 ID'), id, enableLabel, instruction, button('删除规则', () => { row.remove(); mark() })); return row
  }
  function populate(snapshot) {
    base = snapshot; const c = snapshot.config
    for (const role of ['router', 'worker']) { $(role + '-provider').value = c[role + 'Model']?.provider || ''; $(role + '-model').value = c[role + 'Model']?.id || '' }
    $('max-workers').value = c.maxWorkers; $('accept-mode').value = c.mode
    for (const key of ['communication', 'scope', 'delivery']) $('team-' + key).value = c.team[key]
    $('rule-rows').replaceChildren(...c.rules.map(ruleRow)); $('config').value = JSON.stringify(c, null, 2)
    dirty = false; $('settings-save').disabled = true
  }
  async function load(force = false) {
    if (loading) return loading
    if (base && dirty && !force) return
    loading = (async () => {
      controls().forEach(c => { c.disabled = true })
      try { populate(await api('config')); $('settings-notice').textContent = '' }
      finally { controls().forEach(c => { c.disabled = false }); $('settings-save').disabled = !dirty }
    })()
    try { await loading } finally { loading = undefined }
  }
  function collect() {
    const local = structuredClone(base.config)
    for (const role of ['router', 'worker']) {
      const provider = $(role + '-provider').value.trim(), id = $(role + '-model').value.trim()
      if (!!provider !== !!id) throw Error(`${role === 'router' ? 'Router' : 'Worker'} 的提供商和型号须同时填写。`)
      local[role + 'Model'] = provider ? { provider, id } : null
    }
    local.maxWorkers = Number($('max-workers').value); local.mode = $('accept-mode').value
    local.team = Object.fromEntries(['communication', 'scope', 'delivery'].map(k => [k, $('team-' + k).value]))
    local.rules = [...$('rule-rows').children].map(row => ({ id: row.querySelector('[data-field="id"]').value.trim(), enabled: row.querySelector('[data-field="enabled"]').checked, instruction: row.querySelector('[data-field="instruction"]').value }))
    return local
  }
  async function save(local) {
    if (saving) return
    saving = true; controls().forEach(c => { c.disabled = true }); const notice = $('settings-notice'); notice.textContent = '正在保存…'
    try {
      const remote = await api('config'), merged = mergeDraft(base.config, local, remote.config)
      if (merged.conflicts.length) {
        notice.textContent = `设置冲突：${merged.conflicts.join('、')} 已被另一个客户端修改。你的草稿已保留；可继续编辑，或明确放弃草稿后加载最新设置。`; return
      }
      const result = await api('config', 'PUT', { config: merged.value, revision: remote.revision })
      populate(result); notice.textContent = '设置已保存。型号用于新启动的 Agent；现有进程需显式重启服务。'; $('team-notice').textContent = '团队约定已保存。'
      void refresh().catch(e => { $('error').textContent = e.message })
    } catch (e) { notice.textContent = `保存未完成：${e.message}。草稿已保留。` }
    finally { saving = false; controls().forEach(c => { c.disabled = false }); $('settings-save').disabled = !dirty }
  }
  const option = (value, label) => { const o = document.createElement('option'); o.value = value; o.label = label || value; return o }
  function modelOptions(role) { $(role + '-model-options').replaceChildren(...(catalog?.models || []).filter(m => m.provider === $(role + '-provider').value).map(m => option(m.id, m.name))) }
  for (const role of ['router', 'worker']) $(role + '-provider').oninput = () => modelOptions(role)
  $('load-models').onclick = safe(async () => {
    const control = $('load-models'), notice = $('model-catalog-notice'); if (control.disabled) return
    control.disabled = true; notice.textContent = '正在读取实例型号目录…'
    try {
      catalog = await api('models')
      $('provider-options').replaceChildren(...catalog.providers.map(p => option(p.id, p.name)))
      for (const role of ['router', 'worker']) modelOptions(role)
      notice.textContent = '型号目录已载入。先选提供商，再选择或输入型号；账号能否使用该型号可在 Pi 中明确验证。'
    } catch (e) { notice.textContent = `目录未载入：${e.message}。仍可填写已知型号，或运行 /superagent models。` }
    finally { control.disabled = false }
  })
  $('settings-form').oninput = mark
  $('settings-form').onsubmit = event => { event.preventDefault(); safe(() => save(collect()))() }
  $('config-form').onsubmit = event => { event.preventDefault(); safe(() => save(JSON.parse($('config').value)))() }
  $('config').oninput = mark
  $('add-rule').onclick = () => { $('rule-rows').append(ruleRow({ id: '', enabled: true, instruction: '' })); mark() }
  $('settings-reload').onclick = safe(async () => { if (!dirty || confirm('放弃未保存的设置草稿，加载服务器最新版本？')) await load(true) })
  let historyOffset = 0
  async function history() {
    const entries = await api(`config/history?offset=${historyOffset}&limit=20`), root = $('config-history'); root.replaceChildren()
    for (const entry of entries) {
      const card = document.createElement('details'); card.append(text('summary', `版本 ${entry.revision} · ${entry.config.paused ? '暂停' : '派单开启'} · ${entry.config.maxWorkers} 个 Worker`))
      for (const role of ['router', 'worker']) { const model = entry.config[role + 'Model']; card.append(text('p', `${role}: ${model ? model.provider + '/' + model.id : '未配置'}`)) }
      card.append(text('p', entry.config.team.communication), text('p', entry.config.team.scope), text('p', entry.config.team.delivery))
      const raw = document.createElement('details'); raw.append(text('summary', '完整版本快照'), text('pre', JSON.stringify(entry.config, null, 2))); card.append(raw); root.append(card)
    }
    if (historyOffset) root.append(button('较新版本', async () => { historyOffset = Math.max(0, historyOffset - 20); await history() }))
    if (entries.length === 20) root.append(button('更早版本', async () => { historyOffset += 20; await history() }))
  }
  $('settings-history').onclick = safe(async () => { historyOffset = 0; await history() })
  return { load, dirty: () => dirty, clear() { base = undefined; dirty = false; $('settings-form').reset(); $('config').value = ''; $('config-history').replaceChildren() } }
}
