/** Mount the page script once for each instance of its main panel. */
export function mountPanel(name: string, setup: (signal: AbortSignal) => void | Promise<void>): void {
  let mounted: HTMLElement | null = null

  function mount() {
    const panel = document.querySelector<HTMLElement>('main[data-panel]')
    if (panel?.dataset.panel !== name || panel === mounted) return
    mounted = panel
    const controller = new AbortController()
    const signal = controller.signal
    document.addEventListener('astro:before-swap', event => {
      if (event.newDocument === document) return
      controller.abort()
      mounted = null
    }, { signal })
    function start() {
      void Promise.resolve().then(() => {
        if (!signal.aborted) return setup(signal)
      }).catch(error => {
        if (!signal.aborted) console.error('Could not initialize panel:', error)
      })
    }
    if (panel.hasAttribute('data-panel-authorized')) start()
    else panel.addEventListener('filaman:panel-authorized', start, { once: true, signal })
  }

  document.addEventListener('astro:page-load', mount)
  mount()
}
