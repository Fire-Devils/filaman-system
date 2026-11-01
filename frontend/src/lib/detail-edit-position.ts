/** Keep the section being read stationary when the detail form changes mode. */
export function captureDetailEditPosition(main: HTMLElement) {
  const top = main.querySelector('.detail-page-toolbar')?.getBoundingClientRect().bottom ?? 0
  const headings = () => [...main.querySelectorAll<HTMLElement>('h2, h3, h4')].filter(element => element.getBoundingClientRect().height > 0)
  const originalHeadings = headings()
  const anchors = originalHeadings.filter(element => element.getBoundingClientRect().bottom > top).map(element => ({
    text: element.textContent,
    index: originalHeadings.filter(heading => heading.textContent === element.textContent).indexOf(element),
    offset: element.getBoundingClientRect().top,
  }))
  const originalScroll = main.scrollTop
  let restoredScroll: number | null = null
  return () => {
    // A user may scroll while reference/profile data is loading: never pull them back.
    if (restoredScroll !== null && Math.abs(main.scrollTop - restoredScroll) > 1) return
    const currentHeadings = headings()
    const match = anchors.map(anchor => ({ ...anchor, element: currentHeadings.filter(element => element.textContent === anchor.text)[anchor.index] })).find(anchor => anchor.element)
    if (match) main.scrollTop += match.element.getBoundingClientRect().top - match.offset
    else main.scrollTop = originalScroll
    restoredScroll = main.scrollTop
  }
}
