import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 走到「已*」状态算闭环；「需维修/需更换」已转交维修流程，也不再留在本模块待办。
// 「需复调/需复探/需返洗/待检修」这类仍要继续干活，保持待办。
const TERMINAL_BRANCH = new Set(['需维修', '需更换'])

function isDoneStatus(status: string): boolean {
  return status.startsWith('已') || TERMINAL_BRANCH.has(status)
}

type EntryPatch = Record<string, string | number | boolean>

// 动作/保存守卫：返回 null 放行，返回字符串就是挡回原因。merged 是字段合并后的最新值。
type ModuleGuard = (args: {
  meta: ModuleMeta
  merged: EntryRow
  rows: EntryRow[]
  action: string
}) => string | null

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!matched) {
    return null
  }
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// ISO 周（周一为一周起点），返回周一日期串作为周键与周一/周日文案。
function weekRange(date: Date): { key: string; monday: string; sunday: string } {
  const weekday = (date.getDay() + 6) % 7
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - weekday)
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - weekday + 6)
  return { key: formatDate(monday), monday: formatDate(monday), sunday: formatDate(sunday) }
}

// 阀门井：养护班按周报送检查。提交检查时，检查日期必须落在本周；
// 同一口井本周已报送过（已有非「待检查」记录）的，重复报送只算一次，直接挡回。
const valvewellGuard: ModuleGuard = ({ merged, rows, action }) => {
  if (action !== '提交检查') {
    return null
  }
  const date = parseDate(merged['检查日期'])
  if (!date) {
    return '检查日期缺失或格式不正确，养护班按周报送，请填写 YYYY-MM-DD 格式日期'
  }
  const week = weekRange(date)
  const current = weekRange(new Date())
  if (week.key !== current.key) {
    return `养护班按周提交检查，检查日期需落在本周（${current.monday} 至 ${current.sunday}）`
  }
  const wellNo = String(merged['井编号'] ?? '').trim()
  const duplicated = rows.find((item) => {
    if (Number(item.id) === Number(merged.id) || String(item['井编号'] ?? '').trim() !== wellNo) {
      return false
    }
    // 清单里已有同井号记录且检查日期落在要报送的这一周，就视为本周已交过，重交只算一次。
    const itemDate = parseDate(item['检查日期'])
    return itemDate !== null && weekRange(itemDate).key === week.key
  })
  if (duplicated) {
    return `井 ${wellNo} 本周已报送过检查（${duplicated['检查日期']}），重复报送只算一次，清单不再新增`
  }
  return null
}

// 补偿器：伸缩量允许范围 0~200mm。非数值或越界一律挡回（保存草稿除外，空值可暂存）。
const COMPENSATOR_MIN_MM = 0
const COMPENSATOR_MAX_MM = 200

function invalidExtension(value: unknown, action: string): string | null {
  const raw = String(value ?? '').trim().replace(/mm$/i, '').trim()
  if (raw === '') {
    return action ? '伸缩量未填写，无法提交，请填写 0~200mm 内的数值' : null
  }
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount < COMPENSATOR_MIN_MM || amount > COMPENSATOR_MAX_MM) {
    return `伸缩量 ${raw} 超出允许范围（${COMPENSATOR_MIN_MM}~${COMPENSATOR_MAX_MM}mm），一律挡回，请核对后重填`
  }
  return null
}

const compensatorGuard: ModuleGuard = ({ merged, action }) =>
  invalidExtension(merged['伸缩量'], action)

const MODULE_GUARDS: Record<string, ModuleGuard> = {
  valvewell: valvewellGuard,
  compensator: compensatorGuard,
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

// 抽屉/详情与列表读同一份：按编号从同一缓存里取，保存后重读拿到的就是落库后的值。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === Number(id))
}

// 状态流转只允许一步步向前；检查中（第 2 态）可以直接走到末位的维修/更换分支。
function transitionBlocked(meta: ModuleMeta, current: string, target: string): string | null {
  const from = meta.statuses.indexOf(current)
  const to = meta.statuses.indexOf(target)
  const stepForward = to === from + 1
  const toEndBranch = from === 1 && to === meta.statuses.length - 1
  if (!stepForward && !toEndBranch) {
    const start = meta.statuses[0]
    const middle = meta.statuses[1]
    const normal = meta.statuses[meta.statuses.length - 2]
    const branch = meta.statuses[meta.statuses.length - 1]
    const flow = `${start} → ${middle} → ${normal}（${middle} 也可直接转「${branch}」）`
    return `${meta.entity}不能从「${current}」直接流转到「${target}」，请按 ${flow} 顺序操作`
  }
  return null
}

// 唯一写入口：字段修改与状态流转在这里合并、校验后一次落库，页面组件不做业务判断。
export function saveEntry(
  key: string,
  id: number,
  patch: EntryPatch = {},
  action?: string,
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]

  let target: string | null = null
  if (action) {
    target = meta.actionTargets[action] ?? null
    if (!target) {
      return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
    }
    const status = String(current.status)
    if (status === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    const blocked = transitionBlocked(meta, status, target)
    if (blocked) {
      return { ok: false, message: blocked }
    }
  }

  const merged: EntryRow = { ...current, ...patch }
  const guard = MODULE_GUARDS[key]
  if (guard) {
    const reason = guard({ meta, merged, rows, action: action ?? '' })
    if (reason) {
      return { ok: false, message: reason }
    }
  }

  // 动作目标优先；纯字段保存时允许随补丁更新状态（如管理端重置），pending 统一按状态重算。
  const nextStatus = target ?? String(merged.status)
  const updated: EntryRow = {
    ...current,
    ...patch,
    status: nextStatus,
    pending: !isDoneStatus(nextStatus),
    abnormal: Boolean(current.abnormal) || (action ? NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) : false),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return action
    ? { ok: true, message: `${meta.entity}已${action}，当前状态「${nextStatus}」` }
    : { ok: true, message: `${meta.entity}养护记录已保存` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  return saveEntry(key, id, {}, action)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// 循环泵那边的「待检查清单」：直接读阀门井台账这一份。
// 养护完成（已养护）或提出维修（需维修）都算闭环，会自动退出；待检查/检查中仍挂在清单上。
export function linkedWellChecklist(): EntryRow[] {
  return listRows('valvewell').filter((row) => !isDoneStatus(String(row.status)))
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
      pending: entries.filter((row) => !isDoneStatus(String(row.status))).length,
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
