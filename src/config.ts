import Conf from 'conf'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScheduledTask } from './core/scheduler'

export interface GroupState {
    cwd: string
    settings?: {
        model?: string
        permissionMode?: string
        reasoningEffort?: string
        verboseLevel?: 0 | 1 | 2
        providerName?: string
        timeoutSeconds?: number
    }
}

/** Per-topic state (isolated per topic within a group) */
export interface TopicState {
    conversationId?: string
    queryInProgress?: boolean
    settings?: {
        model?: string
        permissionMode?: string
        reasoningEffort?: string
        verboseLevel?: 0 | 1 | 2
        providerName?: string
        timeoutSeconds?: number
    }
}

interface CodeverStore {
    botToken?: string
    testBotToken?: string
    defaultProvider?: string
    pairedChats: Record<string, { authorizedAt: number, cwd?: string }>
    pendingCodes: Record<string, { chatId: number, userId: number, expiresAt: number }>
    pairedUsers: Record<string, { authorizedAt: number, dmChatId: number }>
    groupState: Record<string, GroupState>
    topicState: Record<string, TopicState>
    scheduledTasks: ScheduledTask[]
}

let _store: Conf<CodeverStore> | null = null

function getStore(): Conf<CodeverStore> {
    if (!_store) {
        _store = new Conf<CodeverStore>({
            projectName: 'codever',
            defaults: {
                pairedChats: {},
                pendingCodes: {},
                pairedUsers: {},
                groupState: {},
                topicState: {},
                scheduledTasks: []
            }
        })
    }
    return _store
}

export const config = {
    getBotToken(): string | undefined {
        return getStore().get('botToken')
    },

    setBotToken(token: string): void {
        getStore().set('botToken', token)
    },

    getTestBotToken(): string | undefined {
        return getStore().get('testBotToken')
    },

    setTestBotToken(token: string): void {
        getStore().set('testBotToken', token)
    },

    isPaired(chatId: number): boolean {
        const chats = getStore().get('pairedChats')
        return chatId.toString() in chats
    },

    authorizeChat(chatId: number, cwd?: string): void {
        const chats = getStore().get('pairedChats')
        chats[chatId.toString()] = { authorizedAt: Date.now(), cwd }
        getStore().set('pairedChats', chats)
    },

    getPairedChats(): Record<string, { authorizedAt: number, cwd?: string }> {
        return getStore().get('pairedChats')
    },

    createPendingCode(code: string, chatId: number, userId: number): void {
        const codes = getStore().get('pendingCodes')
        codes[code] = { chatId, userId, expiresAt: Date.now() + 5 * 60 * 1000 } // 5 min
        getStore().set('pendingCodes', codes)
    },

    getPendingCode(code: string): { chatId: number, userId: number, expiresAt: number } | null {
        const codes = getStore().get('pendingCodes')
        return codes[code] || null
    },

    deletePendingCode(code: string): void {
        const codes = getStore().get('pendingCodes')
        delete codes[code]
        getStore().set('pendingCodes', codes)
    },

    isUserAuthorized(userId: number): boolean {
        const users = getStore().get('pairedUsers')
        return userId.toString() in users
    },

    authorizeUser(userId: number, dmChatId: number): void {
        const users = getStore().get('pairedUsers')
        users[userId.toString()] = { authorizedAt: Date.now(), dmChatId }
        getStore().set('pairedUsers', users)
    },

    getUserDmChatId(userId: number): number | undefined {
        const users = getStore().get('pairedUsers')
        return users[userId.toString()]?.dmChatId
    },

    getPairedUsers(): Record<string, { authorizedAt: number, dmChatId: number }> {
        return getStore().get('pairedUsers')
    },

    // --- Topic State persistence (per topic within a group) ---

    saveTopicState(topicKey: string, partial: Partial<TopicState>): void {
        const all = getStore().get('topicState')
        const existing = all[topicKey] || {}
        all[topicKey] = { ...existing, ...partial }
        getStore().set('topicState', all)
        if (partial.conversationId !== undefined) {
            console.error(`[config] saveTopicState: topicKey=${topicKey} conversationId=${partial.conversationId?.slice(0, 8) ?? 'null'}`)
        }
    },

    getTopicState(topicKey: string): TopicState | undefined {
        const all = getStore().get('topicState')
        const state = all[topicKey]
        if (!state) return undefined
        console.error(`[config] getTopicState: topicKey=${topicKey} conversationId=${state.conversationId?.slice(0, 8) ?? 'null'} queryInProgress=${state.queryInProgress ?? false}`)
        return state
    },

    clearTopicConversation(topicKey: string): void {
        const all = getStore().get('topicState')
        if (all[topicKey]) {
            delete all[topicKey].conversationId
            all[topicKey].queryInProgress = false
            getStore().set('topicState', all)
        }
    },

    setTopicQueryInProgress(topicKey: string): void {
        const all = getStore().get('topicState')
        if (!all[topicKey]) {
            all[topicKey] = {}
        }
        all[topicKey].queryInProgress = true
        getStore().set('topicState', all)
    },

    clearTopicQueryInProgress(topicKey: string): void {
        const all = getStore().get('topicState')
        if (all[topicKey]) {
            all[topicKey].queryInProgress = false
            getStore().set('topicState', all)
        }
    },

    // --- Group State persistence (shared across topics in a group) ---

    saveGroupState(chatId: number, partial: Partial<GroupState>): void {
        const all = getStore().get('groupState')
        const key = chatId.toString()
        const existing = all[key] || { cwd: '' }
        const nextSettings = partial.settings !== undefined
            ? { ...partial.settings }
            : existing.settings
        if (nextSettings) {
            for (const [settingKey, value] of Object.entries(nextSettings)) {
                if (value === undefined) {
                    delete (nextSettings as Record<string, unknown>)[settingKey]
                }
            }
        }
        all[key] = {
            ...existing,
            ...partial,
            settings: nextSettings
        }
        getStore().set('groupState', all)
    },

    getGroupState(chatId: number): GroupState | undefined {
        const all = getStore().get('groupState')
        const state = all[chatId.toString()]
        if (!state) return undefined
        return state
    },

    getAllGroupStates(): Record<string, GroupState> {
        return getStore().get('groupState')
    },

    getDefaultProvider(): string {
        return getStore().get('defaultProvider') ?? 'opencode'
    },

    setDefaultProvider(name: string): void {
        getStore().set('defaultProvider', name)
    },

    // --- Scheduled tasks persistence ---

    getScheduledTasks(): ScheduledTask[] {
        return getStore().get('scheduledTasks')
    },

    saveScheduledTasks(tasks: ScheduledTask[]): void {
        getStore().set('scheduledTasks', tasks)
    },
}

const daemonDir = join(homedir(), '.config', 'codever')

export function getDaemonBaseDir(): string {
    return daemonDir
}

export function getDaemonPidPath(): string {
    return join(daemonDir, 'daemon.pid')
}

export function getDaemonLogPath(): string {
    return join(daemonDir, 'logs', 'daemon', 'global.log')
}
