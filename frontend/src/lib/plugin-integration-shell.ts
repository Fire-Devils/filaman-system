import { isValidPluginSlug } from './plugin-nav'

export function mountIntegrationPlugin(frame: HTMLIFrameElement, slug: string): void {
  if (!isValidPluginSlug(slug) || slug.includes('/')) throw new Error('Invalid integration plugin slug')
  const params = new URLSearchParams({
    filaman_hosted: '1',
    filaman_hosted_config: `/plugins/${slug}/hosted-config`,
  })
  // Native integrations observe the parent presentation without replacing their running frame.
  frame.src = `/plugins/${slug}/?${params}`
  frame.title = slug.replaceAll('-', ' ')
}
