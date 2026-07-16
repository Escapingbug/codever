import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '..'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })))
})

describe('ProjectRegistry', () => {
    it('creates opaque project identities and lists active metadata', async () => {
        const fixture = await makeFixture()
        const projectRoot = await makeDirectory(fixture.allowedRoot, 'alpha')
        const registry = await openRegistry(fixture)

        const project = await registry.create({
            name: 'Alpha',
            rootPath: projectRoot,
            defaultProvider: 'codex',
        })

        expect(project).toMatchObject({
            name: 'Alpha',
            rootPath: resolve(projectRoot),
            canonicalRoot: await realpath(projectRoot),
            defaultProvider: 'codex',
        })
        expect(project.id).toMatch(/^proj_[0-9a-f-]{36}$/u)
        expect(await registry.get(project.id)).toEqual(project)
        expect(await registry.list()).toEqual([project])
    })

    it('archives idempotently and excludes archived projects by default', async () => {
        const fixture = await makeFixture()
        const projectRoot = await makeDirectory(fixture.allowedRoot, 'alpha')
        const registry = await openRegistry(fixture)
        const project = await registry.create({ name: 'Alpha', rootPath: projectRoot })

        const archived = await registry.archive(project.id)
        const archivedAgain = await registry.archive(project.id)

        expect(archived.archivedAt).toBeTypeOf('string')
        expect(archivedAgain).toEqual(archived)
        expect(await registry.list()).toEqual([])
        expect(await registry.list({ includeArchived: true })).toEqual([archived])
    })

    it('serializes concurrent creates and persists recoverable JSON', async () => {
        const fixture = await makeFixture()
        const roots = await Promise.all(Array.from({ length: 12 }, (_, index) => (
            makeDirectory(fixture.allowedRoot, `project-${index}`)
        )))
        const registry = await openRegistry(fixture)

        const created = await Promise.all(roots.map((rootPath, index) => registry.create({
            name: `Project ${index}`,
            rootPath,
        })))
        const persisted = JSON.parse(await readFile(fixture.storagePath, 'utf8'))
        const reopened = await openRegistry(fixture)

        expect(new Set(created.map((project) => project.id))).toHaveLength(12)
        expect(persisted).toMatchObject({ schemaVersion: 1 })
        expect(persisted.projects).toHaveLength(12)
        expect(await reopened.list()).toEqual(created)
    })

    it('recovers a completed atomic temporary file after an interrupted rename', async () => {
        const fixture = await makeFixture()
        const projectRoot = await makeDirectory(fixture.allowedRoot, 'alpha')
        const registry = await openRegistry(fixture)
        const project = await registry.create({ name: 'Alpha', rootPath: projectRoot })
        await rename(fixture.storagePath, `${fixture.storagePath}.tmp`)

        const reopened = await openRegistry(fixture)

        expect(await reopened.list()).toEqual([project])
        await expect(readFile(fixture.storagePath, 'utf8')).resolves.toContain(project.id)
    })

    it('rejects relative paths, parent traversal, and roots outside the allowlist', async () => {
        const fixture = await makeFixture()
        const outside = await makeDirectory(fixture.base, 'outside')
        const registry = await openRegistry(fixture)

        await expect(registry.create({ name: 'Relative', rootPath: 'relative' }))
            .rejects.toMatchObject({ code: 'invalid_argument' })
        await expect(registry.create({
            name: 'Traversal',
            rootPath: join(fixture.allowedRoot, '..', 'outside'),
        })).rejects.toMatchObject({ code: 'path_not_allowed' })
        await expect(registry.create({ name: 'Outside', rootPath: outside }))
            .rejects.toMatchObject({ code: 'path_not_allowed' })
    })

    it('rejects a symlink that escapes an allowed root', async () => {
        const fixture = await makeFixture()
        const outside = await makeDirectory(fixture.base, 'outside')
        const escapedLink = join(fixture.allowedRoot, 'escaped-link')
        await symlink(outside, escapedLink, process.platform === 'win32' ? 'junction' : 'dir')
        const registry = await openRegistry(fixture)

        await expect(registry.create({ name: 'Escaped', rootPath: escapedLink }))
            .rejects.toMatchObject({ code: 'path_not_allowed' })
    })

    it('accepts an internal symlink but stores its canonical real path', async () => {
        const fixture = await makeFixture()
        const target = await makeDirectory(fixture.allowedRoot, 'target')
        const internalLink = join(fixture.allowedRoot, 'internal-link')
        await symlink(target, internalLink, process.platform === 'win32' ? 'junction' : 'dir')
        const registry = await openRegistry(fixture)

        const project = await registry.create({ name: 'Internal', rootPath: internalLink })

        expect(project.rootPath).toBe(resolve(internalLink))
        expect(project.canonicalRoot).toBe(await realpath(target))
    })

    it('rejects reopen when an active project symlink has been retargeted outside policy', async () => {
        const fixture = await makeFixture()
        const inside = await makeDirectory(fixture.allowedRoot, 'inside')
        const outside = await makeDirectory(fixture.base, 'outside')
        const link = join(fixture.allowedRoot, 'project-link')
        await symlink(inside, link, process.platform === 'win32' ? 'junction' : 'dir')
        const registry = await openRegistry(fixture)
        await registry.create({ name: 'Linked', rootPath: link })
        await rm(link, { force: true })
        await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

        await expect(openRegistry(fixture)).rejects.toMatchObject({ code: 'path_not_allowed' })
    })

    it('requires an explicit non-empty allowed-root policy', async () => {
        const base = await makeTemporaryDirectory()

        await expect(ProjectRegistry.open({
            storagePath: join(base, 'projects.json'),
            allowedRootPolicy: { roots: [] },
        })).rejects.toEqual(expect.objectContaining({
            code: 'invalid_argument',
        }))
    })

    it('does not expose mutable internal records', async () => {
        const fixture = await makeFixture()
        const projectRoot = await makeDirectory(fixture.allowedRoot, 'alpha')
        const registry = await openRegistry(fixture)
        const project = await registry.create({ name: 'Alpha', rootPath: projectRoot })

        project.name = 'Mutated'
        const listed = await registry.list()
        listed[0].name = 'Also mutated'

        expect((await registry.get(project.id)).name).toBe('Alpha')
    })
})

interface Fixture {
    base: string
    allowedRoot: string
    storagePath: string
}

async function makeFixture(): Promise<Fixture> {
    const base = await makeTemporaryDirectory()
    const allowedRoot = await makeDirectory(base, 'allowed')
    return { base, allowedRoot, storagePath: join(base, 'state', 'projects.json') }
}

async function openRegistry(fixture: Fixture): Promise<ProjectRegistry> {
    return ProjectRegistry.open({
        storagePath: fixture.storagePath,
        allowedRootPolicy: { roots: [fixture.allowedRoot] },
    })
}

async function makeDirectory(parent: string, name: string): Promise<string> {
    const directory = join(parent, name)
    await mkdir(directory, { recursive: true })
    return directory
}

async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-project-registry-'))
    temporaryDirectories.push(directory)
    return directory
}
