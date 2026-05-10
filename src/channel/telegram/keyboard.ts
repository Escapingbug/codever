import { InlineKeyboard } from 'grammy'
import type { SessionEntry } from '@/providers/provider'
import type { ModelEntry } from '@/providers/provider'

export type ResumeSessionEntry = SessionEntry & { cwd?: string; title: string }

export function modeKeyboard(modes?: string[]): InlineKeyboard {
    if (modes && modes.length > 0) {
        const kb = new InlineKeyboard()
        for (let i = 0; i < modes.length; i++) {
            kb.text(modes[i], `mode:${modes[i]}`)
            if (i % 2 === 1 && i < modes.length - 1) kb.row()
        }
        return kb
    }
    return new InlineKeyboard()
        .text('default', 'mode:default')
        .text('acceptEdits', 'mode:acceptEdits')
        .row()
        .text('bypassPermissions', 'mode:bypassPermissions')
        .text('plan', 'mode:plan')
}

export function verboseKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text('🔇 Quiet', 'verbose:0')
        .text('📊 Normal', 'verbose:1')
        .text('📢 Verbose', 'verbose:2')
}

const MODELS_PER_PAGE = 10
const MODEL_PROVIDERS_PER_PAGE = 10

export function modelKeyboard(models: ModelEntry[], page: number = 0): InlineKeyboard {
    if (models.length === 0) {
        return new InlineKeyboard()
    }

    const totalPages = Math.ceil(models.length / MODELS_PER_PAGE)
    const start = page * MODELS_PER_PAGE
    const pageModels = models.slice(start, start + MODELS_PER_PAGE)

    const kb = new InlineKeyboard()
    for (const m of pageModels) {
        kb.text(m.name, `model:${m.id}`).row()
    }

    // Pagination row
    if (totalPages > 1) {
        if (page > 0) {
            kb.text('⬅️ Prev', `mlist:${page - 1}`)
        }
        kb.text(`${page + 1}/${totalPages}`, `mlist:${page}`)
        if (page < totalPages - 1) {
            kb.text('Next ➡️', `mlist:${page + 1}`)
        }
    }

    return kb
}

/**
 * Group models by provider for hierarchical selection.
 * Returns a map of provider -> models[]
 */
export function groupModelsByProvider(models: ModelEntry[]): Map<string, ModelEntry[]> {
    const groups = new Map<string, ModelEntry[]>()
    for (const m of models) {
        const provider = m.provider || m.id.split('/')[0] || 'unknown'
        if (!groups.has(provider)) {
            groups.set(provider, [])
        }
        groups.get(provider)!.push(m)
    }
    return groups
}

/**
 * Two-level model selection keyboard.
 * Level 1: Select provider
 * Level 2: Select model from provider
 */
export function modelProviderKeyboard(models: ModelEntry[], page: number = 0): InlineKeyboard {
    if (models.length === 0) {
        return new InlineKeyboard()
    }

    const groups = groupModelsByProvider(models)
    const kb = new InlineKeyboard()

    // Show providers as buttons (2 per row)
    const providers = Array.from(groups.keys()).sort()
    const totalPages = Math.ceil(providers.length / MODEL_PROVIDERS_PER_PAGE)
    const safePage = Math.min(Math.max(page, 0), Math.max(totalPages - 1, 0))
    const start = safePage * MODEL_PROVIDERS_PER_PAGE
    const pageProviders = providers.slice(start, start + MODEL_PROVIDERS_PER_PAGE)
    for (let i = 0; i < pageProviders.length; i++) {
        const provider = pageProviders[i]
        const count = groups.get(provider)!.length
        kb.text(`${provider} (${count})`, `mprov:${provider}`)
        if (i % 2 === 1) kb.row()
    }

    if (totalPages > 1) {
        kb.row()
        if (safePage > 0) {
            kb.text('⬅️ Prev', `mprovlist:${safePage - 1}`)
        }
        kb.text(`${safePage + 1}/${totalPages}`, `mprovlist:${safePage}`)
        if (safePage < totalPages - 1) {
            kb.text('Next ➡️', `mprovlist:${safePage + 1}`)
        }
    }

    return kb
}

/**
 * Show models for a specific provider with pagination.
 */
export function modelProviderDetailKeyboard(
    models: ModelEntry[],
    provider: string,
    page: number = 0
): InlineKeyboard {
    const groups = groupModelsByProvider(models)
    const providerModels = groups.get(provider) || []

    if (providerModels.length === 0) {
        return new InlineKeyboard().text('⬅️ Back', 'mprov:back')
    }

    const totalPages = Math.ceil(providerModels.length / MODELS_PER_PAGE)
    const start = page * MODELS_PER_PAGE
    const pageModels = providerModels.slice(start, start + MODELS_PER_PAGE)

    const kb = new InlineKeyboard()

    // Show models for this provider
    for (const m of pageModels) {
        // Show just the model name without provider prefix
        const displayName = m.name.includes('/') ? m.name.split('/').slice(1).join('/') : m.name
        kb.text(displayName, `model:${m.id}`).row()
    }

    // Pagination row
    if (totalPages > 1) {
        if (page > 0) {
            kb.text('⬅️ Prev', `mprovpage:${provider}:${page - 1}`)
        }
        kb.text(`${page + 1}/${totalPages}`, `mprovpage:${provider}:${page}`)
        if (page < totalPages - 1) {
            kb.text('Next ➡️', `mprovpage:${provider}:${page + 1}`)
        }
        kb.row()
    }

    // Back button
    kb.text('⬅️ Back to providers', 'mprov:back')

    return kb
}

export function timeoutKeyboard(sessionId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text('⏳ Continue waiting', `timeout:continue:${sessionId}`)
        .text('⏹️ Stop', `timeout:stop:${sessionId}`)
}

export function providerKeyboard(providers: string[], current?: string): InlineKeyboard {
    const kb = new InlineKeyboard()
    for (const p of providers) {
        const label = p === current ? `✅ ${p}` : p
        kb.text(label, `provider:${p}`)
    }
    return kb
}

export function resumeSessionKeyboard(entries: ResumeSessionEntry[], page: number, totalPages: number): InlineKeyboard {
    const kb = new InlineKeyboard()
    for (const e of entries) {
        const title = e.title.length > 40 ? e.title.slice(0, 40) + '…' : e.title
        kb.text(title, `cres:${e.sessionId}`)
        kb.text('ℹ️', `crdet:${e.sessionId}`).row()
    }
    if (page > 0) {
        kb.text('⬅️ Prev', `crlist:${page - 1}`)
    }
    if (page < totalPages - 1) {
        kb.text('Next ➡️', `crlist:${page + 1}`)
    }
    return kb
}
