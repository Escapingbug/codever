import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ClientVerificationCard from '../src/components/ClientVerificationCard.vue'

describe('client verification card', () => {
  it('lets the receiving client accept an incoming SAS request', async () => {
    const wrapper = mount(ClientVerificationCard, { props: {
      flow: { flowId: 'flow-1', stage: 'requested', weStarted: false, otherDeviceId: 'NEWCLIENT' },
      device: { deviceId: 'NEWCLIENT', displayName: 'New phone', verified: false, current: false, verifiable: true },
    } })

    await wrapper.get('button.button--primary').trigger('click')

    expect(wrapper.text()).toContain('New phone')
    expect(wrapper.emitted('advance')).toHaveLength(1)
  })

  it('requires an explicit emoji match before completing verification', async () => {
    const wrapper = mount(ClientVerificationCard, { props: {
      flow: {
        flowId: 'flow-1', stage: 'present_sas', weStarted: true, otherDeviceId: 'NEWCLIENT',
        emojis: [{ symbol: '🐶', description: 'Dog' }, { symbol: '🚀', description: 'Rocket' }],
      },
    } })

    expect(wrapper.get('[aria-label="Client verification emoji"]').text()).toBe('🐶🚀')
    await wrapper.findAll('button').find(button => button.text() === 'They match')!.trigger('click')

    expect(wrapper.emitted('confirm')).toEqual([[true]])
  })
})
