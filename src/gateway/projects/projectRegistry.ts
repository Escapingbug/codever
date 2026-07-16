import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
    ProjectRegistryError,
    type CreateProjectInput,
    type ListProjectsOptions,
    type Project,
    type ProjectRegistryOptions,
} from './types'

interface PersistedProjectRegistry {
    schemaVersion: 1
    projects: Project[]
}

const SCHEMA_VERSION = 1

/**
 * Gateway-local registry of filesystem roots approved for remote project use.
 * Open the registry once and share it with future HTTP or session services.
 */
export class ProjectRegistry {
    private projects: Project[]
    private mutationQueue: Promise<void> = Promise.resolve()

    private constructor(
        private readonly storagePath: string,
        private readonly temporaryPath: string,
        private readonly allowedRoots: readonly string[],
        projects: Project[],
    ) {
        this.projects = projects
    }

    static async open(options: ProjectRegistryOptions): Promise<ProjectRegistry> {
        const storagePath = resolveRequiredPath(options.storagePath, 'storagePath')
        const configuredRoots = options.allowedRootPolicy?.roots
        if (!configuredRoots || configuredRoots.length === 0) {
            throw new ProjectRegistryError(
                'invalid_argument',
                'allowedRootPolicy.roots must contain at least one directory',
            )
        }

        const allowedRoots = await Promise.all(configuredRoots.map((root) => canonicalizeDirectory(
            resolveRequiredPath(root, 'allowedRootPolicy root'),
            'Allowed root',
        )))
        const uniqueAllowedRoots = [...new Set(allowedRoots)]
        const temporaryPath = `${storagePath}.tmp`
        const persisted = await recoverPersistence(storagePath, temporaryPath)
        const projects = persisted?.projects ?? []

        await validateActiveProjects(projects, uniqueAllowedRoots)
        return new ProjectRegistry(storagePath, temporaryPath, uniqueAllowedRoots, projects)
    }

    async create(input: CreateProjectInput): Promise<Project> {
        return this.serializeMutation(async () => {
            const name = requireNonEmpty(input.name, 'name')
            const defaultProvider = optionalNonEmpty(input.defaultProvider, 'defaultProvider')
            const rootPath = resolveProjectInput(input.rootPath)
            const canonicalRoot = await canonicalizeDirectory(rootPath, 'Project root')
            this.assertAllowed(canonicalRoot)

            if (this.projects.some((project) => samePath(project.canonicalRoot, canonicalRoot))) {
                throw new ProjectRegistryError(
                    'project_already_exists',
                    `A project is already registered for ${canonicalRoot}`,
                )
            }

            const project: Project = {
                id: `proj_${randomUUID()}`,
                name,
                rootPath,
                canonicalRoot,
                ...(defaultProvider ? { defaultProvider } : {}),
                createdAt: new Date().toISOString(),
            }
            const nextProjects = [...this.projects, project]
            await this.persist(nextProjects)
            this.projects = nextProjects
            return copyProject(project)
        })
    }

    async list(options: ListProjectsOptions = {}): Promise<Project[]> {
        await this.mutationQueue
        return this.projects
            .filter((project) => options.includeArchived || project.archivedAt === undefined)
            .map(copyProject)
    }

    async get(projectId: string): Promise<Project> {
        await this.mutationQueue
        const project = this.projects.find((candidate) => candidate.id === projectId)
        if (!project) {
            throw new ProjectRegistryError('project_not_found', `Project not found: ${projectId}`)
        }
        return copyProject(project)
    }

    async archive(projectId: string): Promise<Project> {
        return this.serializeMutation(async () => {
            const index = this.projects.findIndex((candidate) => candidate.id === projectId)
            if (index < 0) {
                throw new ProjectRegistryError('project_not_found', `Project not found: ${projectId}`)
            }

            const existing = this.projects[index]
            if (existing.archivedAt) return copyProject(existing)

            const archived: Project = { ...existing, archivedAt: new Date().toISOString() }
            const nextProjects = [...this.projects]
            nextProjects[index] = archived
            await this.persist(nextProjects)
            this.projects = nextProjects
            return copyProject(archived)
        })
    }

    private assertAllowed(canonicalRoot: string): void {
        if (this.allowedRoots.some((allowedRoot) => isWithin(allowedRoot, canonicalRoot))) return
        throw new ProjectRegistryError(
            'path_not_allowed',
            `Project root is outside the configured allowed roots: ${canonicalRoot}`,
        )
    }

    private async persist(projects: Project[]): Promise<void> {
        await mkdir(dirname(this.storagePath), { recursive: true })
        const body = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects }, null, 2)}\n`
        const handle = await open(this.temporaryPath, 'w')
        try {
            await handle.writeFile(body, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }

        await rename(this.temporaryPath, this.storagePath)
        await syncDirectory(dirname(this.storagePath))
    }

    private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation)
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }
}

async function recoverPersistence(
    storagePath: string,
    temporaryPath: string,
): Promise<PersistedProjectRegistry | undefined> {
    try {
        const persisted = await readPersistence(storagePath)
        await rm(temporaryPath, { force: true })
        return persisted
    } catch (error) {
        if (!isMissingFile(error) && !(error instanceof ProjectRegistryError)) throw error

        try {
            const recovered = await readPersistence(temporaryPath)
            await mkdir(dirname(storagePath), { recursive: true })
            await rename(temporaryPath, storagePath)
            await syncDirectory(dirname(storagePath))
            return recovered
        } catch (recoveryError) {
            if (isMissingFile(error) && isMissingFile(recoveryError)) return undefined
            throw error
        }
    }
}

async function readPersistence(path: string): Promise<PersistedProjectRegistry> {
    let value: unknown
    try {
        value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
        if (isMissingFile(error)) throw error
        throw new ProjectRegistryError('invalid_persistence', `Invalid project registry JSON at ${path}`, {
            cause: error,
        })
    }

    if (!isPersistedRegistry(value)) {
        throw new ProjectRegistryError('invalid_persistence', `Invalid project registry data at ${path}`)
    }
    return value
}

function isPersistedRegistry(value: unknown): value is PersistedProjectRegistry {
    if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.projects)) return false
    const ids = new Set<string>()
    for (const project of value.projects) {
        if (!isProject(project) || ids.has(project.id)) return false
        ids.add(project.id)
    }
    return true
}

function isProject(value: unknown): value is Project {
    return isRecord(value)
        && isNonEmptyString(value.id)
        && isNonEmptyString(value.name)
        && isNonEmptyString(value.rootPath)
        && isNonEmptyString(value.canonicalRoot)
        && isNonEmptyString(value.createdAt)
        && (value.defaultProvider === undefined || isNonEmptyString(value.defaultProvider))
        && (value.archivedAt === undefined || isNonEmptyString(value.archivedAt))
}

async function validateActiveProjects(projects: readonly Project[], allowedRoots: readonly string[]): Promise<void> {
    const canonicalRoots = new Set<string>()
    for (const project of projects) {
        if (canonicalRoots.has(project.canonicalRoot)) {
            throw new ProjectRegistryError(
                'invalid_persistence',
                `Duplicate canonical project root in persistence: ${project.canonicalRoot}`,
            )
        }
        canonicalRoots.add(project.canonicalRoot)
        if (project.archivedAt) continue

        const currentCanonicalRoot = await canonicalizeDirectory(project.rootPath, 'Persisted project root')
        if (!samePath(currentCanonicalRoot, project.canonicalRoot)) {
            throw new ProjectRegistryError(
                'path_not_allowed',
                `Persisted project root no longer resolves to its registered canonical path: ${project.rootPath}`,
            )
        }
        if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, currentCanonicalRoot))) {
            throw new ProjectRegistryError(
                'path_not_allowed',
                `Persisted project root is outside the configured allowed roots: ${project.rootPath}`,
            )
        }
    }
}

function resolveProjectInput(value: string): string {
    const input = requireNonEmpty(value, 'rootPath')
    if (!isAbsolute(input)) {
        throw new ProjectRegistryError('invalid_argument', 'rootPath must be absolute')
    }
    if (input.split(/[\\/]+/u).includes('..')) {
        throw new ProjectRegistryError('path_not_allowed', 'rootPath must not contain parent traversal segments')
    }
    return resolve(input)
}

function resolveRequiredPath(value: string, field: string): string {
    const input = requireNonEmpty(value, field)
    if (!isAbsolute(input)) {
        throw new ProjectRegistryError('invalid_argument', `${field} must be absolute`)
    }
    return resolve(input)
}

async function canonicalizeDirectory(path: string, label: string): Promise<string> {
    const canonical = await realpath(path)
    const details = await stat(canonical)
    if (!details.isDirectory()) {
        throw new ProjectRegistryError('invalid_argument', `${label} must be a directory: ${path}`)
    }
    await access(canonical, constants.R_OK)
    return canonical
}

function isWithin(parent: string, candidate: string): boolean {
    const child = relative(parent, candidate)
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function samePath(left: string, right: string): boolean {
    return relative(left, right) === ''
}

function requireNonEmpty(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ProjectRegistryError('invalid_argument', `${field} must be a non-empty string`)
    }
    return value.trim()
}

function optionalNonEmpty(value: string | undefined, field: string): string | undefined {
    return value === undefined ? undefined : requireNonEmpty(value, field)
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function copyProject(project: Project): Project {
    return { ...project }
}

function isMissingFile(error: unknown): boolean {
    return isRecord(error) && error.code === 'ENOENT'
}

async function syncDirectory(directory: string): Promise<void> {
    let handle
    try {
        handle = await open(directory, 'r')
        await handle.sync()
    } catch (error) {
        if (process.platform !== 'win32') throw error
    } finally {
        await handle?.close()
    }
}
