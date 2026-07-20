<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayPathHelp, gatewayPathPlaceholder, validateGatewayPath } from '../gatewayPath'
import { gatewayCanControl, isGatewayAuthorizationError } from '../gatewayAccess'
import { clientSession } from '../state/clientSession'
import { useCodeverState } from '../state/codeverState'

const state = useCodeverState()
const router = useRouter()
const hasLoadedProjects = (id: string) => Object.prototype.hasOwnProperty.call(state.projectsByGateway, id)
const projects = computed(() => state.gateways.value.flatMap(gateway =>
  (state.projectsByGateway[gateway.id] ?? []).map(project => ({ project, gateway })),
))
const authorizedGateways = computed(() => state.gateways.value.filter(gateway =>
  gatewayCanControl(gateway) && hasLoadedProjects(gateway.id) && !isGatewayAuthorizationError(state.errors[`projects:${gateway.id}`]),
))
const availableGateways = computed(() => authorizedGateways.value.filter(gateway => gateway.status === 'online'))
const authorizationCount = computed(() => state.gateways.value.filter(gateway =>
  isGatewayAuthorizationError(state.errors[`projects:${gateway.id}`]),
).length)
const realFailures = computed(() => state.gateways.value.filter(gateway => {
  const error = state.errors[`projects:${gateway.id}`]
  return error && !isGatewayAuthorizationError(error) && hasLoadedProjects(gateway.id)
}))
const loading = computed(() => state.pending.value.has('gateways') || state.gateways.value.some(gateway =>
  state.pending.value.has(`projects:${gateway.id}`),
))
const creating = ref(false)
const createOpen = ref(false)
const createError = ref('')
const gatewayId = ref('')
const projectName = ref('')
const rootPath = ref('')
const defaultProvider = ref('')
const selectedGateway = computed(() => availableGateways.value.find(gateway => gateway.id === gatewayId.value))
const pathPlaceholder = computed(() => gatewayPathPlaceholder(selectedGateway.value?.platform))
const pathHelp = computed(() => gatewayPathHelp(selectedGateway.value?.platform))
const connectionError = computed(() => clientSession.initializationError.value || state.errors.gateways)

function resetProjectForm(): void {
  createOpen.value = false
  createError.value = ''
  projectName.value = ''
  rootPath.value = ''
  defaultProvider.value = ''
}

function openProjectForm(): void {
  resetProjectForm()
  createOpen.value = true
}

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
    resetProjectForm()
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
  <div class="page page--overview workspace-page">
    <header class="page-header page-header--compact">
      <div><span class="eyebrow">Workspace</span><h1>Projects</h1><p>Pick up your work from any connected computer.</p></div>
      <button class="button button--primary" :disabled="!availableGateways.length" @click="openProjectForm">New project</button>
    </header>

    <RouterLink v-if="authorizationCount" class="setup-notice" to="/machines">
      <span class="setup-notice__icon" aria-hidden="true">!</span>
      <span><strong>{{ authorizationCount }} computer{{ authorizationCount === 1 ? '' : 's' }} waiting for authorization</strong><small>Approve this client before it can run commands.</small></span>
      <span>Open Computers →</span>
    </RouterLink>
    <div v-if="connectionError" class="error-banner"><strong>Connection unavailable.</strong> {{ connectionError }}</div>
    <RouterLink v-for="gateway in realFailures" :key="gateway.id" class="error-banner error-banner--link" :to="{ name: 'gateway', params: { gatewayId: gateway.id } }">
      <strong>{{ gateway.name }} needs attention.</strong> {{ state.errors[`projects:${gateway.id}`] }}
    </RouterLink>

    <section v-if="createOpen" class="settings-section project-create-panel">
      <div class="section-heading"><div><span class="eyebrow">On a computer</span><h2>New project</h2></div><button class="icon-button" aria-label="Close" @click="resetProjectForm">×</button></div>
      <p class="form-help">Choose a connected computer and register an existing directory.</p>
      <form class="server-form" @submit.prevent="createProject">
        <label>Computer
          <select v-model="gatewayId" required><option v-for="gateway in availableGateways" :key="gateway.id" :value="gateway.id">{{ gateway.name }} · {{ gateway.platform }}</option></select>
        </label>
        <label>Project name<input v-model="projectName" required autocomplete="off" placeholder="My project" /></label>
        <label>Project folder<input v-model="rootPath" required autocomplete="off" :placeholder="pathPlaceholder" /><small class="field-help">{{ pathHelp }}</small></label>
        <label>Default provider (optional)<input v-model="defaultProvider" autocomplete="off" placeholder="codex" /></label>
        <p v-if="createError" class="error-banner" role="alert">{{ createError }}</p>
        <div class="form-actions"><button type="button" class="button" @click="resetProjectForm">Cancel</button><button class="button button--primary" :disabled="creating">{{ creating ? 'Creating…' : 'Create project' }}</button></div>
      </form>
    </section>

    <div v-if="projects.length" class="project-grid">
      <RouterLink v-for="entry in projects" :key="`${entry.gateway.id}:${entry.project.id}`" class="project-card" :to="{ name: 'project', params: { gatewayId: entry.gateway.id, projectId: entry.project.id } }">
        <span class="folder-icon" aria-hidden="true">▰</span>
        <div><h3>{{ entry.project.name }}</h3><small class="gateway-label"><StatusDot :status="entry.gateway.status" />{{ entry.gateway.name }}<template v-if="entry.gateway.status !== 'online'"> · Offline</template></small></div>
        <span class="card-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div v-else-if="loading" class="empty-state"><span class="loader" /><h2>Loading projects</h2><p>Available projects will appear as each computer responds.</p></div>
    <div v-else-if="!state.gateways.value.length || !authorizedGateways.length" class="empty-state">
      <span class="empty-orbit" aria-hidden="true">◎</span><h2>Connect your first computer</h2><p>Authorize a computer, then its projects and coding sessions will appear here.</p><RouterLink class="button button--primary" to="/machines">Open Computers</RouterLink>
    </div>
    <div v-else class="empty-state">
      <span class="empty-orbit" aria-hidden="true">▰</span><h2>No projects yet</h2><p>Add a folder from one of your connected computers.</p><button class="button button--primary" :disabled="!availableGateways.length" @click="openProjectForm">Add project</button>
    </div>
  </div>
</template>
