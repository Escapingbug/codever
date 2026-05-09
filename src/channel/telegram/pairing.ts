import { randomBytes } from 'node:crypto'
import { config } from '@/config'

export const pairing = {
    isAuthorized(userId: number): boolean {
        return config.isUserAuthorized(userId)
    },

    generateCode(chatId: number, userId: number): string {
        const code = randomBytes(4).toString('hex').toUpperCase()
        config.createPendingCode(code, chatId, userId)
        return code
    },

    /**
     * Complete pairing for a given code.
     * Returns { chatId, userId } that was paired, or null if code is invalid/expired.
     */
    completePairing(code: string): { chatId: number, userId: number } | null {
        const pending = config.getPendingCode(code)
        if (!pending) return null
        if (Date.now() > pending.expiresAt) {
            config.deletePendingCode(code)
            return null
        }
        config.authorizeUser(pending.userId, pending.chatId)
        config.deletePendingCode(code)
        return { chatId: pending.chatId, userId: pending.userId }
    },

    listPairedChats(): Array<{ chatId: number, authorizedAt: number }> {
        const chats = config.getPairedChats()
        return Object.entries(chats).map(([id, data]) => ({
            chatId: parseInt(id),
            authorizedAt: data.authorizedAt
        }))
    }
}
