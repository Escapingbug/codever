import { registerContextResources, registerContextTools } from './resources'
import { registerNotifyTools } from './tools/notify'
import { registerSessionTools, type SessionToolContext } from './tools/session'

export interface CodeverMcpRegistrationOptions {
    sessionTools?: SessionToolContext
}

export function registerCodeverMcpSurface(server: any, options: CodeverMcpRegistrationOptions = {}): void {
    registerContextResources(server)
    registerContextTools(server)
    registerNotifyTools(server)

    if (options.sessionTools) {
        registerSessionTools(server, options.sessionTools)
    }
}
