export interface Project {
    id: string
    name: string
    /** Absolute path supplied when the project was registered. */
    rootPath: string
    /** Gateway-local real path used for filesystem authorization. */
    canonicalRoot: string
    defaultProvider?: string
    createdAt: string
    archivedAt?: string
}

export interface CreateProjectInput {
    name: string
    rootPath: string
    defaultProvider?: string
}

export interface ListProjectsOptions {
    includeArchived?: boolean
}

export interface AllowedRootPolicy {
    /** Existing directories under which project roots may be registered. */
    roots: readonly string[]
}

export interface ProjectRegistryOptions {
    storagePath: string
    allowedRootPolicy: AllowedRootPolicy
}

export type ProjectRegistryErrorCode =
    | 'invalid_argument'
    | 'path_not_allowed'
    | 'project_not_found'
    | 'project_already_exists'
    | 'invalid_persistence'

export class ProjectRegistryError extends Error {
    constructor(
        public readonly code: ProjectRegistryErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'ProjectRegistryError'
    }
}
