import { describe, expect, it, vi } from 'vitest'
import { RelayApi } from '../src/api/relayApi'
import { DEMO_RELAY_URL } from '../src/api/demoRelay'
import { SessionEventSocket } from '../src/api/sessionEventSocket'

describe('offline Demo Relay', () => {
  it('supports health, login, inventory and rich history without network access', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const api = new RelayApi({ baseUrl: DEMO_RELAY_URL, fetch: fetcher })

    await api.checkHealth()
    const login = await api.login({ username: 'demo', password: 'demo' })
    const gateways = await api.listGateways()
    const projects = await api.listProjects(gateways[0]!.id)
    const sessions = await api.listSessions(projects[0]!.id)
    const history = await api.getSessionEvents(sessions[0]!.id)

    expect(login.user.username).toBe('demo')
    expect(gateways.some(gateway => gateway.status === 'online')).toBe(true)
    expect(history.events.some(event => event.event.kind === 'tool')).toBe(true)
    expect(history.events.some(event => event.event.kind === 'decision_request')).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('publishes demo mutations through the normal live event client', async () => {
    const api = new RelayApi({ baseUrl: DEMO_RELAY_URL })
    const sessions = await api.listSessions('demo-project-codever')
    const session = sessions[0]!
    const received: string[] = []
    const states: string[] = []
    const socket = new SessionEventSocket({
      baseUrl: DEMO_RELAY_URL,
      sessionId: session.id,
      after: session.lastEventSeq,
      onEvent: event => received.push(event.event.kind),
      onStateChange: state => states.push(state),
    })

    socket.connect()
    await api.sendMessage(session.id, { text: 'Show the preview response' })

    expect(states).toEqual(['connecting', 'connected'])
    expect(received).toContain('user_message')
    expect(received).toContain('tool')
    expect(received).toContain('assistant_text_delta')
    socket.close()
  })

  it('requires the documented demo credentials', async () => {
    const api = new RelayApi({ baseUrl: DEMO_RELAY_URL })
    await expect(api.login({ username: 'real', password: 'secret' })).rejects.toThrow('demo / demo')
  })

  it('previews Gateway pairing and approval without network access', async () => {
    const api = new RelayApi({ baseUrl: DEMO_RELAY_URL })
    const pending = await api.getGatewayEnrollment('DEMO-2345')

    const enrolled = await api.approveGatewayEnrollment('DEMO-2345', {
      fingerprint: pending.fingerprint, name: pending.name, platform: pending.platform,
    })

    expect(enrolled.gatewayId).toBe(pending.gatewayId)
    expect(enrolled.status).toBe('approved')
    expect((await api.listGatewayEnrollments()).enrollments).toEqual([])
  })
})
