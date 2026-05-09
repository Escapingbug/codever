import type { AgentPermissionResult } from '@/providers/provider'
import { inferToolKind, isReadOnlyKind, type ToolKind } from './toolKind'

export type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all'

export interface ResolvePermissionInput {
    toolName: string
    input: unknown
    toolKind?: string
}

export type PermissionDecision = 'allow' | 'deny' | 'ask'

export function resolvePermission(
    mode: PermissionMode,
    { toolName, toolKind }: ResolvePermissionInput
): PermissionDecision {
    switch (mode) {
        case 'approve-all':
            return 'allow'

        case 'deny-all':
            return 'deny'

        case 'approve-reads': {
            const kind = inferToolKind(toolKind, toolName)
            if (isReadOnlyKind(kind)) {
                return 'allow'
            }
            return 'ask'
        }
    }
}

export function decisionToResult(decision: PermissionDecision, input: unknown): AgentPermissionResult | null {
    switch (decision) {
        case 'allow':
            return {
                behavior: 'allow',
                updatedInput: (input as Record<string, unknown>) || {},
            }
        case 'deny':
            return {
                behavior: 'deny',
                message: 'Permission denied by policy.',
            }
        case 'ask':
            return null
    }
}
