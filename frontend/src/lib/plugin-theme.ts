export function syncPluginTheme(frame: HTMLIFrameElement, signal: AbortSignal, onDocumentReady?: (embedded: Document) => void): void {
  if (signal.aborted) return
  const host = document.documentElement
  let plugin: HTMLElement | null = null
  let previousDocument: Document | null = null
  let animationFrame = 0
  const preparedDocuments = new WeakSet<Document>()
  const sync = () => {
    const theme = host.dataset.theme || 'brand'
    if (plugin && plugin.dataset.theme !== theme) plugin.dataset.theme = theme
  }
  const hostObserver = new MutationObserver(sync)
  // Plugins may restore the retired localStorage theme after their async startup.
  const pluginObserver = new MutationObserver(sync)
  const watch = () => {
    pluginObserver.disconnect()
    plugin = null
    let embedded: Document | null = null
    try {
      embedded = frame.contentDocument
      plugin = embedded?.documentElement ?? null
      if (plugin) pluginObserver.observe(plugin, { attributes: true, attributeFilter: ['data-theme'] })
      const view = plugin?.ownerDocument.defaultView
      view?.addEventListener('pagehide', hideForNavigation, { signal })
      view?.addEventListener('pageshow', restore, { signal })
      sync()
    } catch { return /* External pages cannot inherit a same-origin theme. */ }
    if (onDocumentReady && embedded && embedded.URL !== 'about:blank' && embedded.readyState !== 'loading' && !preparedDocuments.has(embedded)) {
      preparedDocuments.add(embedded)
      onDocumentReady(embedded)
    }
  }
  const reveal = () => {
    cancelAnimationFrame(animationFrame)
    watch()
    frame.style.visibility = 'visible'
    previousDocument = null
  }
  const awaitDocument = () => {
    if (signal.aborted) return
    try {
      const embedded = frame.contentDocument
      // Parsed HTML can be used while images or nested frames are still loading.
      if (embedded && embedded !== previousDocument && embedded.URL !== 'about:blank' && embedded.readyState !== 'loading') {
        reveal()
        return
      }
    } catch { /* Inaccessible pages are revealed by their load event. */ }
    animationFrame = requestAnimationFrame(awaitDocument)
  }
  const conceal = () => {
    frame.style.visibility = 'hidden'
    cancelAnimationFrame(animationFrame)
    animationFrame = requestAnimationFrame(awaitDocument)
  }
  const hideForNavigation = () => {
    previousDocument = plugin?.ownerDocument ?? null
    conceal()
  }
  const restore = (event: PageTransitionEvent) => {
    if (event.persisted) reveal()
  }
  hostObserver.observe(host, { attributes: true, attributeFilter: ['data-theme'] })
  frame.addEventListener('load', reveal, { signal })
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(animationFrame)
    hostObserver.disconnect()
    pluginObserver.disconnect()
    plugin = null
    previousDocument = null
  }, { once: true })
  conceal()
  watch()
}
