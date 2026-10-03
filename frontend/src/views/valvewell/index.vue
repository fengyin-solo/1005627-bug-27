<template>
  <section class="page" data-module="valvewell">
    <header class="page-head">
      <div>
        <h2>阀门井维护管理</h2>
        <p class="page-desc">维护阀门井，围绕井编号、所属管段、井盖状况、阀门型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记阀门井</button>
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
        <input
          v-model="filters[field]"
          :type="field === '检查日期' ? 'date' : 'text'"
          :placeholder="`按${field}检索`"
        />
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDrawer(row)">详情</button>
            <button
              v-for="action in actionsFor(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无阀门井维护数据，可先登记阀门井</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条阀门井维护记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <template v-if="drawer">
      <div class="drawer-mask" @click="closeDrawer" />
      <div class="drawer" role="dialog" aria-modal="true" aria-label="阀门井养护详情">
        <div class="drawer-head">
          <h3>阀门井详情 · {{ form['井编号'] }}</h3>
          <button class="drawer-close" type="button" @click="closeDrawer">×</button>
        </div>
        <div class="drawer-body">
          <p class="drawer-hint">
            当前状态「{{ drawer.status }}」；养护班按周提交检查，检查日期需落在本周
            （{{ weekText }}）。同一口井同周重复报送只算一次。井盖状况、检查日期与养护措施一次保存，
            列表与抽屉读同一份。
          </p>
          <label v-for="field in readonlyFields" :key="field" class="field-block">
            <span>{{ field }}</span>
            <input :value="String(form[field] ?? '')" readonly />
          </label>
          <label class="field-block">
            <span>井盖状况</span>
            <input v-model="form['井盖状况']" placeholder="如：完好 / 沉降 / 缺失" />
          </label>
          <label class="field-block">
            <span>检查人</span>
            <input v-model="form['检查人']" placeholder="养护班检查人" />
          </label>
          <label class="field-block">
            <span>检查日期</span>
            <input v-model="form['检查日期']" type="date" />
          </label>
          <label class="field-block">
            <span>养护措施</span>
            <input v-model="form['养护措施']" placeholder="如：清淤、紧固螺栓、更换密封" />
          </label>
          <p v-if="drawerMessage" class="drawer-result" :class="drawerOk ? 'ok' : 'bad'">
            {{ drawerMessage }}
          </p>
        </div>
        <div class="drawer-foot">
          <button class="btn" type="button" @click="saveOnly">保存养护记录</button>
          <button
            v-for="action in actionsFor(String(drawer.status))"
            :key="action"
            class="btn primary"
            type="button"
            @click="saveWithAction(action)"
          >
            {{ action }}
          </button>
        </div>
      </div>
    </template>
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
  saveEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('valvewell')
const columns = ["井编号", "所属管段", "井盖状况", "阀门型号", "检查人", "检查日期", "养护措施", "井体状态"]
const filterFields = ["井编号", "检查日期", "井盖状况"]
const readonlyFields = ["井编号", "所属管段", "阀门型号", "井体状态"]
// 状态与动作沿用 modules.ts 里登记的既有判定：待检查→检查中→已养护/需维修。
const actionByStatus: Record<string, string[]> = {
  "待检查": ["提交检查"],
  "检查中": ["确认养护", "提出维修"],
  "已养护": [],
  "需维修": [],
}
const stats = ref([
  { label: "待检查阀门井", value: 0 },
  { label: "已养护阀门井", value: 0 },
  { label: "需维修阀门井", value: 0 },
])

const rows = ref<EntryRow[]>([])
const allData = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusSummary = computed(() =>
  ["待检查", "检查中", "已养护", "需维修"].map((status: string) => ({
    status,
    count: allData.value.filter((row) => String(row.status) === status).length,
  })),
)
const weekText = computed(() => {
  const now = new Date()
  const weekday = (now.getDay() + 6) % 7
  const fmt = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }
  return `${fmt(-weekday)} 至 ${fmt(6 - weekday)}`
})

// 抽屉持有的是编辑缓冲；保存成功后用台账数据重新灌回，保证回显就是落库值。
const drawer = ref<EntryRow | null>(null)
const form = ref<Record<string, string | number | boolean>>({})
const drawerMessage = ref('')
const drawerOk = ref(true)

function actionsFor(status: string): string[] {
  return actionByStatus[status] ?? []
}

function editablePatch(): Record<string, string> {
  return {
    "井盖状况": String(form.value["井盖状况"] ?? '').trim(),
    "检查人": String(form.value["检查人"] ?? '').trim(),
    "检查日期": String(form.value["检查日期"] ?? '').trim(),
    "养护措施": String(form.value["养护措施"] ?? '').trim(),
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '阀门井登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openDrawer(row: EntryRow) {
  const latest = getEntry(meta.key, Number(row.id))
  if (!latest) {
    errorMessage.value = `没有找到编号为 ${row.id} 的阀门井`
    return
  }
  drawer.value = latest
  form.value = { ...latest }
  drawerMessage.value = ''
}

function closeDrawer() {
  drawer.value = null
  form.value = {}
  drawerMessage.value = ''
}

// 保存后抽屉里的内容重新从台账读取——回显、列表、详情始终是同一份。
function syncDrawerFromStore(result: { ok: boolean; message: string }) {
  drawerOk.value = result.ok
  drawerMessage.value = result.message
  if (!result.ok || !drawer.value) {
    return
  }
  const latest = getEntry(meta.key, Number(drawer.value.id))
  if (latest) {
    drawer.value = latest
    form.value = { ...latest }
  }
  reload()
}

function saveOnly() {
  if (!drawer.value) {
    return
  }
  syncDrawerFromStore(saveEntry(meta.key, Number(drawer.value.id), editablePatch()))
}

function saveWithAction(action: string) {
  if (!drawer.value) {
    return
  }
  syncDrawerFromStore(saveEntry(meta.key, Number(drawer.value.id), editablePatch(), action))
}

function reload() {
  errorMessage.value = ''
  try {
    allData.value = listEntries(meta.key).items
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = [
      { label: "待检查阀门井", value: allData.value.filter((row) => String(row.status) === "待检查").length },
      { label: "已养护阀门井", value: allData.value.filter((row) => String(row.status) === "已养护").length },
      { label: "需维修阀门井", value: allData.value.filter((row) => String(row.status) === "需维修").length },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '阀门井维护列表读取失败'
  }
}

onMounted(reload)
</script>
