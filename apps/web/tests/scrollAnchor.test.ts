// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { captureScrollAnchor, restoreScrollAnchor } from '../src/timeline/scrollAnchor'

describe('timeline scroll anchor', () => {
  it('keeps the first visible message at the same viewport offset after prepending', () => {
    const container = document.createElement('div')
    const visible = document.createElement('article')
    visible.dataset.timelineKey = 'visible-message'
    container.append(visible)
    let messageTop = 25
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(container, 'scrollTop', { configurable: true, writable: true, value: 150 })
    container.getBoundingClientRect = () => rect(0, 400)
    visible.getBoundingClientRect = () => rect(messageTop, 80)

    const anchor = captureScrollAnchor(container)
    messageTop = 225
    restoreScrollAnchor(container, anchor)

    expect(container.scrollTop).toBe(350)
  })

  it('falls back to the prepended height when the anchored node is unavailable', () => {
    const container = document.createElement('div')
    let height = 500
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(container, 'scrollTop', { configurable: true, writable: true, value: 100 })
    container.getBoundingClientRect = () => rect(0, 400)

    const anchor = captureScrollAnchor(container)
    height = 680
    restoreScrollAnchor(container, anchor)

    expect(container.scrollTop).toBe(280)
  })
})

function rect(top: number, height: number): DOMRect {
  return {
    x: 0, y: top, top, bottom: top + height, left: 0, right: 320,
    width: 320, height, toJSON: () => ({}),
  }
}
