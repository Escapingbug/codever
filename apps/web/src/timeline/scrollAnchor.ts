export interface TimelineScrollAnchor {
  key?: string
  offset: number
  scrollHeight: number
}

export function captureScrollAnchor(container: HTMLElement): TimelineScrollAnchor {
  const containerTop = container.getBoundingClientRect().top
  const visible = [...container.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .find(element => element.getBoundingClientRect().bottom > containerTop)
  return {
    ...(visible?.dataset.timelineKey ? { key: visible.dataset.timelineKey } : {}),
    offset: visible ? visible.getBoundingClientRect().top - containerTop : 0,
    scrollHeight: container.scrollHeight,
  }
}

export function restoreScrollAnchor(container: HTMLElement, anchor: TimelineScrollAnchor): void {
  const anchored = anchor.key
    ? [...container.querySelectorAll<HTMLElement>('[data-timeline-key]')]
      .find(element => element.dataset.timelineKey === anchor.key)
    : undefined
  if (anchored) {
    const currentOffset = anchored.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTop += currentOffset - anchor.offset
    return
  }
  container.scrollTop += container.scrollHeight - anchor.scrollHeight
}
