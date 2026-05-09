import { describe, it, expect } from 'vitest'
import { inferToolKind, isReadOnlyKind, type ToolKind } from '@/permissions/toolKind'
import { resolvePermission, decisionToResult, type PermissionMode } from '@/permissions/resolvePermission'

describe('inferToolKind', () => {
    it('returns explicit toolKind when provided', () => {
        expect(inferToolKind('read', 'Bash')).toBe('read')
        expect(inferToolKind('edit', 'Read')).toBe('edit')
        expect(inferToolKind('execute', 'Read')).toBe('execute')
        expect(inferToolKind('search', 'Read')).toBe('search')
        expect(inferToolKind('write', 'Read')).toBe('write')
    })

    it('normalizes toolKind case-insensitively', () => {
        expect(inferToolKind('Read')).toBe('read')
        expect(inferToolKind('EDIT')).toBe('edit')
        expect(inferToolKind('Execute')).toBe('execute')
    })

    it('falls back to title heuristic when toolKind is absent', () => {
        expect(inferToolKind(undefined, 'Read')).toBe('read')
        expect(inferToolKind(undefined, 'read:src/foo.ts')).toBe('read')
        expect(inferToolKind(undefined, 'Glob')).toBe('search')
        expect(inferToolKind(undefined, 'Grep')).toBe('search')
        expect(inferToolKind(undefined, 'Bash')).toBe('execute')
        expect(inferToolKind(undefined, 'Edit')).toBe('edit')
        expect(inferToolKind(undefined, 'Write')).toBe('write')
    })

    it('returns undefined for unknown toolKind and toolName', () => {
        expect(inferToolKind(undefined, 'CustomTool')).toBeUndefined()
        expect(inferToolKind(undefined, undefined)).toBeUndefined()
    })

    it('returns undefined for unrecognized toolKind string', () => {
        expect(inferToolKind('unknown')).toBeUndefined()
    })

    it('ignores title heuristic when toolKind is provided', () => {
        expect(inferToolKind('read', 'Bash')).toBe('read')
    })

    it('handles search-related heuristic names', () => {
        expect(inferToolKind(undefined, 'search')).toBe('search')
        expect(inferToolKind(undefined, 'find')).toBe('search')
        expect(inferToolKind(undefined, 'list_files')).toBe('search')
        expect(inferToolKind(undefined, 'list_directory')).toBe('search')
    })

    it('handles execute-related heuristic names', () => {
        expect(inferToolKind(undefined, 'execute')).toBe('execute')
        expect(inferToolKind(undefined, 'run_command')).toBe('execute')
        expect(inferToolKind(undefined, 'shell')).toBe('execute')
        expect(inferToolKind(undefined, 'terminal')).toBe('execute')
        expect(inferToolKind(undefined, 'command')).toBe('execute')
    })
})

describe('resolvePermission', () => {
    it('approve-all always allows', () => {
        expect(resolvePermission('approve-all', { toolName: 'Bash', input: {} })).toBe('allow')
        expect(resolvePermission('approve-all', { toolName: 'Read', input: {} })).toBe('allow')
        expect(resolvePermission('approve-all', { toolName: 'Edit', input: {} })).toBe('allow')
    })

    it('deny-all always denies', () => {
        expect(resolvePermission('deny-all', { toolName: 'Bash', input: {} })).toBe('deny')
        expect(resolvePermission('deny-all', { toolName: 'Read', input: {} })).toBe('deny')
    })

    it('approve-reads allows read toolKind', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Read', input: {}, toolKind: 'read' })).toBe('allow')
    })

    it('approve-reads allows search toolKind', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Grep', input: {}, toolKind: 'search' })).toBe('allow')
    })

    it('approve-reads asks for execute toolKind', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Bash', input: {}, toolKind: 'execute' })).toBe('ask')
    })

    it('approve-reads asks for edit toolKind', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Edit', input: {}, toolKind: 'edit' })).toBe('ask')
    })

    it('approve-reads asks for write toolKind', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Write', input: {}, toolKind: 'write' })).toBe('ask')
    })

    it('approve-reads uses title heuristic when toolKind absent', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Read', input: {} })).toBe('allow')
        expect(resolvePermission('approve-reads', { toolName: 'Glob', input: {} })).toBe('allow')
        expect(resolvePermission('approve-reads', { toolName: 'Grep', input: {} })).toBe('allow')
    })

    it('approve-reads asks for unknown tool without toolKind', () => {
        expect(resolvePermission('approve-reads', { toolName: 'CustomTool', input: {} })).toBe('ask')
    })

    it('approve-reads asks for execute by title heuristic', () => {
        expect(resolvePermission('approve-reads', { toolName: 'Bash', input: {} })).toBe('ask')
    })
})
