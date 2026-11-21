export function syncPluginTheme(frame: HTMLIFrameElement, signal: AbortSignal): void {
  if (signal.aborted) return
  const host = document.documentElement
  let plugin: HTMLElement | null = null
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
    try {
      plugin = frame.contentDocument?.documentElement ?? null
      if (plugin) pluginObserver.observe(plugin, { attributes: true, attributeFilter: ['data-theme'] })
      sync()
    } catch { /* External pages cannot inherit a same-origin theme. */ }
  }
  hostObserver.observe(host, { attributes: true, attributeFilter: ['data-theme'] })
  frame.addEventListener('load', watch, { signal })
  signal.addEventListener('abort', () => {
    hostObserver.disconnect()
    pluginObserver.disconnect()
    plugin = null
  }, { once: true })
  watch()
}
