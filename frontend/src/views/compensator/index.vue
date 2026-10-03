<template>
  <section class="page" data-module="compensator">
    <header class="page-head">
      <div>
        <h2>补偿器检查管理</h2>
        <p class="page-desc">维护补偿器检查记录，围绕检查编号、所属管段、补偿器型号、伸缩量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记补偿器检查记录</button>
        <button class="btn" type="button" @click="exportRows">导出补偿器检查清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无补偿器检查数据，可先登记补偿器检查记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条补偿器检查记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <template v-if="drawer">
      <div class="drawer-mask" @click="closeDrawer" />
      <div class="drawer" role="dialog" aria-modal="true" aria-label="补偿器检查详情">
        <div class="drawer-head">
          <h3>补偿器详情 · {{ form['检查编号'] }}</h3>
          <button class="drawer-close" type="button" @click="closeDrawer">×</button>
        </div>
        <div class="drawer-body">
          <p class="drawer-hint">
            伸缩量允许范围 0~200mm，非数值或超出范围一律挡回；提交检查、判定正常、提出更换前都会先校验。
          </p>
          <label v-for="field in readonlyFields" :key="field" class="field-block">
            <span>{{ field }}</span>
            <input :value="String(form[field] ?? '')" readonly />
          </label>
          <label class="field-block">
            <span>伸缩量（mm，允许 0~200）</span>
            <input v-model="form['伸缩量']" type="number" min="0" max="200" step="0.1" placeholder="如：45" />
          </label>
          <label class="field-block">
            <span>外观状况</span>
            <input v-model="form['外观状况']" placeholder="如：无锈蚀 / 保温完好" />
          </label>
          <label class="field-block">
            <span>检查人</span>
            <input v-model="form['检查人']" placeholder="检查人" />
          </label>
          <label class="field-block">
            <span>检查日期</span>
            <input v-model="form['检查日期']" type="date" />
          </label>
          <p v-if="drawerMessage" class="drawer-result" :class="drawerOk ? 'ok' : 'bad'">
            {{ drawerMessage }}
          </p>
        </div>
        <div class="drawer-foot">
          <button class="btn" type="button" @click="saveOnly">保存检查记录</button>
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

const meta = moduleMeta('compensator')
const columns = ["检查编号", "所属管段", "补偿器型号", "伸缩量", "外观状况", "检查人", "检查日期", "部件状态"]
const filterFields = ["检查编号", "所属管段", "补偿器型号"]
const readonlyFields = ["检查编号", "所属管段", "补偿器型号", "部件状态"]
// 状态与动作沿用 modules.ts 里登记的既有判定：待检查→检查中→状态正常/需更换。
const actionByStatus: Record<string, string[]> = {
  "待检查": ["提交检查"],
  "检查中": ["判定正常", "提出更换"],
  "状态正常": [],
  "需更换": [],
}
const stats = ref([
  { label: "待检查补偿器", value: 0 },
  { label: "状态正常补偿器", value: 0 },
  { label: "需更换补偿器", value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusSummary = computed(() =>
  ["待检查", "检查中", "状态正常", "需更换"].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const drawer = ref<EntryRow | null>(null)
const form = ref<Record<string, string | number | boolean>>({})
const drawerMessage = ref('')
const drawerOk = ref(true)

function actionsFor(status: string): string[] {
  return actionByStatus[status] ?? []
}

function editablePatch(): Record<string, string> {
  return {
    "伸缩量": String(form.value["伸缩量"] ?? '').trim(),
    "外观状况": String(form.value["外观状况"] ?? '').trim(),
    "检查人": String(form.value["检查人"] ?? '').trim(),
    "检查日期": String(form.value["检查日期"] ?? '').trim(),
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
  errorMessage.value = '补偿器检查记录登记入口尚未接入审批流'
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
    errorMessage.value = `没有找到编号为 ${row.id} 的补偿器检查记录`
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const all = listEntries(meta.key).items
    stats.value = [
      { label: "待检查补偿器", value: all.filter((row) => String(row.status) === "待检查").length },
      { label: "状态正常补偿器", value: all.filter((row) => String(row.status) === "状态正常").length },
      { label: "需更换补偿器", value: all.filter((row) => String(row.status) === "需更换").length },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '补偿器检查列表读取失败'
  }
}

onMounted(reload)
</script>
