import { registerContextResources, registerContextTools } from './resources'
import { registerNotifyTools } from './tools/notify'
import { registerSessionTools, type SessionToolContext } from './tools/session'

export interface CodeverMcpRegistrationOptions {
    includeNotifyTools?: boolean
    sessionTools?: SessionToolContext
}

export function registerCodeverMcpSurface(server: any, options: CodeverMcpRegistrationOptions = {}): void {
    registerContextResources(server)
    registerContextTools(server)

    const includeNotifyTools = options.includeNotifyTools ?? hasSessionIdentity()
    if (includeNotifyTools) {
        registerNotifyTools(server)
    }

    if (options.sessionTools) {
        registerSessionTools(server, options.sessionTools)
    }
}

function hasSessionIdentity(): boolean {
    return Boolean(process.env.CODEVER_CONVERSATION_ID?.trim())
}
