<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayPathHelp, gatewayPathPlaceholder, validateGatewayPath } from '../gatewayPath'
import { useCodeverState } from '../state/codeverState'

const state = useCodeverState()
const router = useRouter()
const projects = computed(() => state.gateways.value.flatMap(gateway =>
  (state.projectsByGateway[gateway.id] ?? []).map(project => ({ project, gateway })),
))
const availableGateways = computed(() => state.gateways.value.filter(gateway => gateway.status === 'online'))
const selectedGateway = computed(() => availableGateways.value.find(gateway => gateway.id === gatewayId.value))
const pathPlaceholder = computed(() => gatewayPathPlaceholder(selectedGateway.value?.platform))
const pathHelp = computed(() => gatewayPathHelp(selectedGateway.value?.platform))
const unavailableGateways = computed(() => state.gateways.value.filter(gateway =>
  state.errors[`projects:${gateway.id}`],
))
const creating = ref(false)
const createOpen = ref(false)
const createError = ref('')
const gatewayId = ref('')
const projectName = ref('')
const rootPath = ref('')
const defaultProvider = ref('')

watch(availableGateways, gateways => {
  if (!gateways.some(gateway => gateway.id === gatewayId.value)) gatewayId.value = gateways[0]?.id ?? ''
}, { immediate: true })

async function createProject(): Promise<void> {
  creating.value = true
  createError.value = ''
  try {
    const pathError = validateGatewayPath(rootPath.value, selectedGateway.value?.platform)
    if (pathError) throw new Error(pathError)
    const project = await state.createProject(gatewayId.value, {
      name: projectName.value,
      rootPath: rootPath.value,
      ...(defaultProvider.value.trim() ? { defaultProvider: defaultProvider.value.trim() } : {}),
    })
    createOpen.value = false
    projectName.value = ''
    rootPath.value = ''
    defaultProvider.value = ''
    await router.push({ name: 'project', params: { gatewayId: gatewayId.value, projectId: project.id } })
  } catch (error) {
    createError.value = error instanceof Error ? error.message : 'Unable to create project'
  } finally {
    creating.value = false
  }
}

onMounted(() => state.loadWorkspace())
</script>

<template>
  <div class="page page--overview">
    <header class="page-header">
      <div><span class="eyebrow">Your workspace</span><h1>Projects</h1><p>Continue work across every connected machine.</p></div>
      <div class="header-actions">
        <button class="button" :disabled="state.pending.value.has('gateways')" @click="state.loadWorkspace">Refresh</button>
        <button class="button button--primary" :disabled="!availableGateways.length" @click="createOpen = !createOpen">＋ New project</button>
      </div>
    </header>
    <div v-if="state.errors.gateways" class="error-banner"><strong>Relay unavailable</strong>{{ state.errors.gateways }}</div>

    <section v-if="createOpen" class="settings-section project-create-panel">
      <div class="section-heading"><div><span class="eyebrow">Remote machine</span><h2>New project</h2></div></div>
      <p class="form-help">Register an existing directory on a Gateway. The path must be inside one of that Gateway's approved roots.</p>
      <form class="relay-form" @submit.prevent="createProject">
        <label>Gateway
          <select v-model="gatewayId" required>
            <option v-for="gateway in availableGateways" :key="gateway.id" :value="gateway.id">{{ gateway.name }} · {{ gateway.platform }}</option>
          </select>
        </label>
        <label>Project name<input v-model="projectName" required autocomplete="off" placeholder="happy-server" /></label>
        <label>Absolute path on Gateway<input v-model="rootPath" required autocomplete="off" :placeholder="pathPlaceholder" /><small class="field-help">{{ pathHelp }}</small></label>
        <label>Default provider (optional)<input v-model="defaultProvider" autocomplete="off" placeholder="codex" /></label>
        <p v-if="createError" class="error-banner" role="alert">{{ createError }}</p>
        <div class="form-actions">
          <button type="button" class="button" @click="createOpen = false">Cancel</button>
          <button class="button button--primary" :disabled="creating">{{ creating ? 'Creating…' : 'Create project' }}</button>
        </div>
      </form>
    </section>

    <div v-if="projects.length" class="project-grid">
      <RouterLink
        v-for="entry in projects"
        :key="`${entry.gateway.id}:${entry.project.id}`"
        class="project-card"
        :to="{ name: 'project', params: { gatewayId: entry.gateway.id, projectId: entry.project.id } }"
      >
        <span class="folder-icon">◇</span>
        <div>
          <h3>{{ entry.project.name }}</h3>
          <small class="gateway-label"><StatusDot :status="entry.gateway.status" /> {{ entry.gateway.name }}</small>
        </div>
        <span class="card-arrow">→</span>
      </RouterLink>
    </div>

    <section v-if="unavailableGateways.length" class="unavailable-gateways">
      <div class="section-heading"><div><span class="eyebrow">Needs attention</span><h2>Unavailable projects</h2></div></div>
      <RouterLink v-for="gateway in unavailableGateways" :key="gateway.id" class="gateway-notice" :to="{ name: 'gateway', params: { gatewayId: gateway.id } }">
        <StatusDot :status="gateway.status" />
        <span><strong>{{ gateway.name }}</strong><small>{{ state.errors[`projects:${gateway.id}`] }}</small></span>
        <span>Pair →</span>
      </RouterLink>
    </section>

    <div v-if="!projects.length && !state.pending.value.size && !state.errors.gateways" class="empty-state">
      <span class="empty-orbit">◇</span><h2>No projects available</h2><p>Pair a Gateway, then create a project from an approved directory on that machine.</p>
    </div>
  </div>
</template>
