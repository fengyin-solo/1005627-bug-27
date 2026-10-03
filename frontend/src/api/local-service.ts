import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 补偿器伸缩量的允许范围（毫米）：超出范围的报送、保存与流转一律挡回。
const EXPANSION_LIMIT = { min: 0, max: 300 }

// 状态位的既有判定：各模块前两个状态是在办（计入待办），其余状态视为办结。
// 与 seed 数据里 pending 标记的口径一致，养护流转沿用这套判定。
function isOpenStatus(meta: ModuleMeta, status: string): boolean {
  const index = meta.statuses.indexOf(status)
  return index >= 0 && index < 2
}

// 字段级校验：目前只有补偿器伸缩量有范围要求，后续模块有自己的门槛也加在这里。
function validateFields(
  key: string,
  row: Record<string, string | number | boolean>,
): string {
  if (key === 'compensator') {
    const raw = String(row['伸缩量'] ?? '').trim()
    const value = Number(raw)
    if (
      raw === '' ||
      !Number.isFinite(value) ||
      value < EXPANSION_LIMIT.min ||
      value > EXPANSION_LIMIT.max
    ) {
      return `伸缩量「${raw || '空'}」超出允许范围（${EXPANSION_LIMIT.min}–${EXPANSION_LIMIT.max}mm），已挡回`
    }
  }
  return ''
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 单条读取：抽屉详情的回显和列表读的是同一份数据，不存在两份对不上。
export function getEntry(key: string, id: number): EntryRow | null {
  const row = listRows(key).find((item) => Number(item.id) === id)
  return row ? { ...row } : null
}

// 保存业务字段：只改字段不碰状态（状态流转走 runAction），校验通过后一次落库。
export function updateEntry(
  key: string,
  id: number,
  changes: Record<string, string>,
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const patch: Record<string, string> = {}
  for (const field of meta.fields) {
    if (field in changes) {
      patch[field] = changes[field]
    }
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, message: '没有可保存的字段改动' }
  }
  const invalid = validateFields(key, { ...rows[index], ...patch })
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已保存，台账与详情是同一份数据` }
}

// 检查报送：养护班按周提交检查。同一编号已有在办记录时，重复报送只算一次，
// 不再开新单；上一单办结（已养护/需维修等）后的新一周报送才生成新记录。
export function submitInspection(key: string, data: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const idField = meta.fields[0]
  const idValue = (data[idField] ?? '').trim()
  if (!idValue) {
    return { ok: false, message: `请填写${idField}再报送` }
  }
  const rows = listRows(key)
  const existing = rows.find(
    (row) => String(row[idField]) === idValue && isOpenStatus(meta, String(row.status)),
  )
  if (existing) {
    return {
      ok: true,
      message: `${meta.entity}${idValue}已有在办记录（编号 ${existing.id}），重复报送只计一次`,
    }
  }
  const invalid = validateFields(key, data)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const target = meta.actionTargets['提交检查'] ?? meta.statuses[0]
  const row: EntryRow = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    status: target,
    pending: isOpenStatus(meta, target),
    abnormal: false,
  }
  for (const field of meta.fields) {
    row[field] = (data[field] ?? '').trim()
  }
  saveRows(key, [...rows, row])
  return { ok: true, message: `${meta.entity}${idValue}检查报送已入账，当前状态「${target}」` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 伸缩量超出范围的一律挡回；「提出更换」是超范围时的正当处置，放行。
  if (key === 'compensator' && action !== '提出更换') {
    const invalid = validateFields(key, rows[index])
    if (invalid) {
      return { ok: false, message: invalid }
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isOpenStatus(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
