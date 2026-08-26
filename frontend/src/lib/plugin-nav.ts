/**
 * Navigation helpers for plugin pages served by the backend.
 *
 * A page the backend serves under /plugin-page/<slug> replaces the whole
 * window — navigation included — because it is plain HTML outside this
 * shell. Routing such a link through /plugin-view?p=<slug> keeps the shell
 * around it instead. A plugin that points at a page of this frontend, like
 * the built-in imports, keeps its own link unchanged.
 *
 * Shared by Layout.astro (sidebar nav), admin/system.astro (plugin admin
 * table) and plugin-view.astro (slug validation) so the three don't drift.
 */

export const PLUGIN_PAGE_PREFIX = '/plugin-page/'

export function navHrefFor(pageUrl: string): string {
  if (!pageUrl.startsWith(PLUGIN_PAGE_PREFIX)) return pageUrl
  const slug = pageUrl.slice(PLUGIN_PAGE_PREFIX.length)
  return `/plugin-view?p=${encodeURIComponent(slug)}`
}

/**
 * A plugin's page_url is a free string set by the plugin author — see
 * PLUGIN_KEY_PATTERN in backend/app/services/plugin_service.py, which
 * constrains plugin_key but never validates page_url, stored as
 * String(500) in backend/app/models/plugin.py. The serving route
 * (`@app.get("/plugin-page/{plugin_slug:path}")` in backend/app/main.py)
 * uses FastAPI's `:path` converter and matches page_url as a plain string,
 * so multi-segment slugs (e.g. "foo/bar") and underscores are both valid
 * there already. This pattern must accept the same shapes while still
 * rejecting anything that could make `frame.src` resolve somewhere
 * unexpected: no ".." segments, no empty segments (no "//"), no leading/
 * trailing slash, no query strings or other special characters.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/

// page_url is String(500) in the DB; PLUGIN_PAGE_PREFIX ('/plugin-page/')
// takes 13 of those, so the slug portion can never legitimately exceed this.
const MAX_SLUG_LENGTH = 500 - PLUGIN_PAGE_PREFIX.length

export function isValidPluginSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug)
}
