export type ToolKind = 'read' | 'edit' | 'write' | 'execute' | 'search'

const TOOL_KIND_VALUES: Record<string, ToolKind> = {
    read: 'read',
    edit: 'edit',
    write: 'write',
    execute: 'execute',
    search: 'search',
}

const TITLE_HEURISTICS: Array<{ pattern: RegExp; kind: ToolKind }> = [
    { pattern: /^read(?::|$)/i, kind: 'read' },
    { pattern: /^(glob|grep|search|find|list_files|list_directory)/i, kind: 'search' },
    { pattern: /^(bash|execute|run_command|shell|terminal|command)/i, kind: 'execute' },
    { pattern: /^(edit|replace|patch|modify_file)/i, kind: 'edit' },
    { pattern: /^(write|create_file|save)/i, kind: 'write' },
]

export function inferToolKind(toolKind?: string, toolName?: string): ToolKind | undefined {
    if (toolKind) {
        const normalized = toolKind.toLowerCase()
        if (normalized in TOOL_KIND_VALUES) {
            return TOOL_KIND_VALUES[normalized]
        }
    }

    if (toolName) {
        for (const { pattern, kind } of TITLE_HEURISTICS) {
            if (pattern.test(toolName)) {
                return kind
            }
        }
    }

    return undefined
}

export function isReadOnlyKind(kind: ToolKind | undefined): boolean {
    return kind === 'read' || kind === 'search'
}
