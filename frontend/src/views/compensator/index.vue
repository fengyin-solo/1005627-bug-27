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
          <td :colspan="columns.length + 2" class="empty-state">暂无补偿器检查数据，可先登记补偿器检查记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条补偿器检查记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="drawerOpen" class="drawer-mask" @click.self="closeDrawer">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>补偿器检查详情 · {{ drawerRow?.['检查编号'] ?? '' }}</h3>
          <button class="link" type="button" @click="closeDrawer">关闭</button>
        </header>
        <div class="drawer-body">
          <template v-if="drawerRow">
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
            <p class="drawer-hint">伸缩量允许范围 0–300mm，超出范围的保存与报送一律挡回。</p>
          </template>
          <p v-if="drawerError" class="error-text">{{ drawerError }}</p>
        </div>
        <footer class="drawer-foot">
          <button class="btn primary" type="button" @click="saveDetail">保存</button>
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
  updateEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compensator')
const columns = ["检查编号", "所属管段", "补偿器型号", "伸缩量", "外观状况", "检查人", "检查日期", "部件状态"]
const actions = ["提交检查", "判定正常", "提出更换"]
const statuses = ["待检查", "检查中", "状态正常", "需更换"]
const statRules = [
  { label: "待检查补偿器", status: "待检查" },
  { label: "状态正常补偿器", status: "状态正常" },
  { label: "需更换补偿器", status: "需更换" },
]
const editableFields = ["伸缩量", "外观状况", "检查日期"]
const readonlyFields = ["检查编号", "所属管段", "补偿器型号", "检查人", "部件状态"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
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

function openCreate() {
  errorMessage.value = '补偿器检查记录登记入口尚未接入审批流'
}

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
  drawerId.value = Number(row.id)
  drawerError.value = ''
  drawerOpen.value = true
  refreshDrawer()
}

function closeDrawer() {
  drawerOpen.value = false
}

// 伸缩量超出范围的保存会被数据层挡回，改正后再提交检查。
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
    errorMessage.value = error instanceof Error ? error.message : '补偿器检查列表读取失败'
  }
}

onMounted(reload)
</script>
