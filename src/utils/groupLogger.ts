import { appendFileSync, mkdirSync, closeSync, openSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export class GroupLogger {
    private logBaseDir: string
    private globalFd: number
    private globalPath: string
    private groupFds = new Map<string, number>()
    private groupTitles = new Map<string, string>()

    constructor(baseDir: string, source: string) {
        this.logBaseDir = join(baseDir, 'logs', source)
        mkdirSync(this.logBaseDir, { recursive: true })
        this.globalPath = join(this.logBaseDir, 'global.log')
        this.globalFd = openSync(this.globalPath, 'a')
    }

    get baseDir(): string { return this.logBaseDir }
    get globalLogPath(): string { return this.globalPath }

    registerGroupTitle(chatId: number | string, title: string): void {
        const key = String(chatId)
        const safeTitle = this.sanitizeTitle(title)
        this.groupTitles.set(key, safeTitle)

        // Migration: if an fd was already opened with the old directory name,
        // close it so the next getGroupFd() will recreate in the new directory.
        const existingFd = this.groupFds.get(key)
        if (existingFd !== undefined) {
            try { closeSync(existingFd) } catch {}
            this.groupFds.delete(key)
        }
    }

    getGroupDirName(chatId: number | string): string {
        return this.formatGroupDirName(chatId)
    }

    private sanitizeTitle(title: string): string {
        return title.replace(/[\/\\:*?"<>|]/g, '_')
    }

    private formatGroupDirName(chatId: number | string): string {
        const key = String(chatId)
        const title = this.groupTitles.get(key)
        if (title) {
            return `${title}(${key})`
        }
        return key
    }

    private ensureGroupDir(chatId: number | string): string {
        const dirName = this.formatGroupDirName(chatId)
        const dir = join(this.logBaseDir, 'groups', dirName)
        mkdirSync(dir, { recursive: true })
        return dir
    }

    private getGroupFd(chatId: number | string): number {
        const key = String(chatId)
        const existing = this.groupFds.get(key)
        if (existing !== undefined) return existing
        this.ensureGroupDir(chatId)
        const dirName = this.formatGroupDirName(chatId)
        const fd = openSync(join(this.logBaseDir, 'groups', dirName, 'session.log'), 'a')
        this.groupFds.set(key, fd)
        return fd
    }

    global(line: string): void {
        try { appendFileSync(this.globalFd, `[${ts()}] ${line}\n`) } catch {}
    }

    group(chatId: number | string, line: string): void {
        try { appendFileSync(this.getGroupFd(chatId), `[${ts()}] ${line}\n`) } catch {}
    }

    both(chatId: number | string | null | undefined, line: string): void {
        if (chatId != null) {
            this.group(chatId, line)
        } else {
            this.global(line)
        }
    }

    getGroupLogPath(chatId: number | string): string {
        this.ensureGroupDir(chatId)
        const dirName = this.formatGroupDirName(chatId)
        return join(this.logBaseDir, 'groups', dirName, 'session.log')
    }

    listGroupDirs(): string[] {
        const groupsDir = join(this.logBaseDir, 'groups')
        try {
            return readdirSync(groupsDir)
        } catch {
            return []
        }
    }

    close(): void {
        try { closeSync(this.globalFd) } catch {}
        for (const fd of this.groupFds.values()) {
            try { closeSync(fd) } catch {}
        }
        this.groupFds.clear()
    }
}

function ts(): string {
    return new Date().toISOString()
}
