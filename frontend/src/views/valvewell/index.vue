<template>
  <section class="page" data-module="valvewell">
    <header class="page-head">
      <div>
        <h2>阀门井维护管理</h2>
        <p class="page-desc">维护阀门井，围绕井编号、所属管段、井盖状况、阀门型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">提交检查报送</button>
        <button class="btn" type="button" @click="exportRows">导出阀门井维护清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          class="clickable-row"
          @click="openDetail(row)"
        >
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click.stop="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click.stop="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无阀门井维护数据，可先提交检查报送</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条阀门井维护记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="drawerOpen" class="drawer-mask" @click.self="closeDrawer">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>{{ drawerMode === 'create' ? '阀门井检查报送' : `阀门井详情 · ${drawerRow?.['井编号'] ?? ''}` }}</h3>
          <button class="link" type="button" @click="closeDrawer">关闭</button>
        </header>
        <div class="drawer-body">
          <template v-if="drawerMode === 'view' && drawerRow">
            <dl class="detail-grid">
              <div v-for="field in readonlyFields" :key="field" class="detail-item">
                <dt>{{ field }}</dt>
                <dd>{{ drawerRow[field] ?? '—' }}</dd>
              </div>
              <div class="detail-item">
                <dt>当前状态</dt>
                <dd>{{ drawerRow.status }}</dd>
              </div>
            </dl>
            <label v-for="field in editableFields" :key="field" class="form-item">
              <span>{{ field }}</span>
              <input v-if="field === '检查日期'" v-model="form[field]" type="date" />
              <input v-else v-model="form[field]" :placeholder="`填写${field}`" />
            </label>
          </template>
          <template v-else>
            <label v-for="field in createFields" :key="field" class="form-item">
              <span>{{ field }}</span>
              <input v-if="field === '检查日期'" v-model="form[field]" type="date" />
              <input v-else v-model="form[field]" :placeholder="`填写${field}`" />
            </label>
            <p class="drawer-hint">养护班按周提交检查：同一井编号已有在办记录时，重复报送只计一次。</p>
          </template>
          <p v-if="drawerError" class="error-text">{{ drawerError }}</p>
        </div>
        <footer class="drawer-foot">
          <button class="btn primary" type="button" @click="submitDrawer">保存</button>
          <button class="btn ghost" type="button" @click="closeDrawer">取消</button>
        </footer>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitInspection,
  updateEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('valvewell')
const columns = ["井编号", "所属管段", "井盖状况", "阀门型号", "检查人", "检查日期", "养护措施", "井体状态"]
const actions = ["提交检查", "确认养护", "提出维修"]
const statuses = ["待检查", "检查中", "已养护", "需维修"]
// 统计卡片按状态实时计数：养护一办结，待检查清单立刻减一。
const statRules = [
  { label: "待检查阀门井", status: "待检查" },
  { label: "已养护阀门井", status: "已养护" },
  { label: "需维修阀门井", status: "需维修" },
]
const editableFields = ["井盖状况", "检查日期", "养护措施"]
const readonlyFields = ["井编号", "所属管段", "阀门型号", "检查人", "井体状态"]
const createFields = ["井编号", "所属管段", "井盖状况", "阀门型号", "检查人", "检查日期", "养护措施"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["井编号", "所属管段", "井盖状况", "检查日期"]
const stats = computed(() =>
  statRules.map((item) => ({
    label: item.label,
    value: rows.value.filter((row) => String(row.status) === item.status).length,
  })),
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const drawerOpen = ref(false)
const drawerMode = ref<'view' | 'create'>('view')
const drawerId = ref<number | null>(null)
const drawerRow = ref<EntryRow | null>(null)
const form = ref<Record<string, string>>({})
const drawerError = ref('')

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// 抽屉回显一律重新读数据层，和台账列表用同一份数。
function refreshDrawer() {
  if (drawerId.value === null) {
    return
  }
  const fresh = getEntry(meta.key, drawerId.value)
  if (!fresh) {
    closeDrawer()
    return
  }
  drawerRow.value = fresh
  form.value = Object.fromEntries(
    editableFields.map((field) => [field, String(fresh[field] ?? '')]),
  )
}

function openDetail(row: EntryRow) {
  drawerMode.value = 'view'
  drawerId.value = Number(row.id)
  drawerError.value = ''
  drawerOpen.value = true
  refreshDrawer()
}

function openCreate() {
  drawerMode.value = 'create'
  drawerId.value = null
  drawerRow.value = null
  form.value = Object.fromEntries(createFields.map((field) => [field, '']))
  drawerError.value = ''
  drawerOpen.value = true
}

function closeDrawer() {
  drawerOpen.value = false
}

function submitDrawer() {
  if (drawerMode.value === 'create') {
    submitCreate()
  } else {
    saveDetail()
  }
}

// 养护措施、井盖状况、检查日期一次落库；保存后列表与抽屉回显都重读同一份。
function saveDetail() {
  if (drawerId.value === null) {
    return
  }
  drawerError.value = ''
  const result = updateEntry(meta.key, drawerId.value, form.value)
  if (!result.ok) {
    drawerError.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
  refreshDrawer()
}

function submitCreate() {
  drawerError.value = ''
  const result = submitInspection(meta.key, form.value)
  if (!result.ok) {
    drawerError.value = result.message
    return
  }
  noticeMessage.value = result.message
  closeDrawer()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '阀门井维护列表读取失败'
  }
}

onMounted(reload)
</script>
