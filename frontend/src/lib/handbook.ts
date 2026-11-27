/**
 * Context-sensitive link into the manual (Otterwiki at docu.filaman.app).
 *
 * Every context key maps to `Page#anchor` per language. The anchors are the
 * Otterwiki heading ids, so a renamed heading in the manual needs a change here.
 * Dialogs and drawers may carry `data-handbook="<key>"`; the innermost open one
 * wins over the route.
 */

export const HANDBOOK_BASE = 'https://docu.filaman.app'

export type HandbookLang = 'de' | 'en'
export type HandbookTarget = { de: string; en: string }

export const handbookTargets = {
  contents: { de: '00-Inhalt', en: '00-Contents' },
  login: { de: '02-Anmeldung', en: '02-Login' },
  dashboard: { de: '04-Dashboard', en: '04-Dashboard' },
  dashboardLowStock: { de: '04-Dashboard#warnsystem-low-stock-spools', en: '04-Dashboard#alert-system-low-stock-spools' },

  manufacturers: { de: '05-Hersteller', en: '05-Manufacturers' },
  manufacturerAdd: { de: '05-Hersteller#hersteller-hinzufugen', en: '05-Manufacturers#add-a-manufacturer' },
  manufacturerDetail: { de: '05-Hersteller#katalogverknupfung-und-herstellerdetails', en: '05-Manufacturers#catalog-link-and-manufacturer-details' },
  manufacturerBulkMatch: { de: '18-Filamandb#186-mit-filaman-db-abgleichen-massenabgleich', en: '18-Filamandb#186-match-with-filaman-db-bulk-match' },

  filaments: { de: '06-Filamente', en: '06-Filaments' },
  filamentAdd: { de: '06-Filamente#filament-hinzufugen', en: '06-Filaments#add-a-filament' },
  filamentDetail: { de: '06-Filamente#funktionen', en: '06-Filaments#features' },
  printProfiles: { de: '06-Filamente#druckprofile', en: '06-Filaments#print-profiles' },
  communityProfiles: { de: '27-Filaman-Db-Community#276-community-druckprofile', en: '27-Filaman-Db-Community#276-community-print-profiles' },
  colors: { de: '12-Farbverwaltung', en: '12-Colors' },
  colorAdd: { de: '12-Farbverwaltung#farbe-anlegen', en: '12-Colors#add-a-color' },
  colorCleanup: { de: '12-Farbverwaltung#duplikate-vergleichen-und-zusammenfuhren', en: '12-Colors#comparing-and-merging-duplicates' },

  spools: { de: '07-Spulen', en: '07-Spools' },
  spoolAdd: { de: '07-Spulen#spule-hinzufugen', en: '07-Spools#add-a-spool' },
  spoolDetail: { de: '07-Spulen#spule-bearbeiten', en: '07-Spools#edit-delete-a-spool' },
  spoolLog: { de: '07-Spulen#protokoll', en: '07-Spools#spool-log' },
  spoolBulk: { de: '07-Spulen#sammelaktionen', en: '07-Spools#bulk-actions' },
  spoolRfid: { de: '07-Spulen#rfid-tags-einer-spule', en: '07-Spools#rfid-tags-of-a-spool' },
  spoolRfidLink: { de: '07-Spulen#neue-spule-per-rfid-verknupfen', en: '07-Spools#linking-a-new-spool-via-rfid' },
  spoolFromEmpty: { de: '07-Spulen#spule-voll-leergewicht-von-der-waage-berechnen', en: '07-Spools#spool-full-calculate-the-empty-spool-weight-from-the-scale' },
  spoolWeights: { de: '07-Spulen#gewichte-und-preis', en: '07-Spools#weights-and-price' },
  spoolStatus: { de: '07-Spulen#spulenstatus', en: '07-Spools#spool-status' },
  spoolMoisture: { de: '07-Spulen#feuchte-tracking', en: '07-Spools#moisture-tracking' },
  labels: { de: '25-Etiketten-Designer#251-etikettendruck-offnen', en: '25-Label-Designer#251-opening-label-printing' },

  locations: { de: '08-Lagerorte', en: '08-Locations' },
  locationAdd: { de: '08-Lagerorte#lagerort-hinzufugen', en: '08-Locations#add-a-location' },
  locationBulk: { de: '08-Lagerorte#mehrere-lagerorte-bearbeiten-oder-loschen', en: '08-Locations#editing-or-deleting-several-locations' },
  locationRfid: { de: '08-Lagerorte#rfid-integration', en: '08-Locations#rfid-integration' },

  printers: { de: '09-Drucker', en: '09-Printers' },
  printerAdd: { de: '09-Drucker#drucker-hinzufugen', en: '09-Printers#add-a-printer' },
  printerDetail: { de: '09-Drucker#druckereinstellungen-und-slicer-profile', en: '09-Printers#printer-settings-and-slicer-profiles' },

  printJobs: { de: '22-Druckjobs', en: '22-Print-Jobs' },
  printJobLog: { de: '22-Druckjobs#druck-erfassen', en: '22-Print-Jobs#logging-a-print' },
  printJobComplete: { de: '22-Druckjobs#offenen-druck-abschlieen', en: '22-Print-Jobs#completing-an-open-print' },
  printJobDetail: { de: '22-Druckjobs#detailseite-eines-drucks', en: '22-Print-Jobs#print-detail-page' },
  printProject: { de: '22-Druckjobs#222-reiter-projekte', en: '22-Print-Jobs#222-projects-tab' },
  slicerLink: { de: '22-Druckjobs#223-slicer-link', en: '22-Print-Jobs#223-slicer-link' },

  analytics: { de: '23-Analyse', en: '23-Analytics' },
  amsView: { de: '26-Ams-Ansicht', en: '26-Ams-View' },

  filamentDb: { de: '18-Filamandb#187-banner-mit-filaman-db-verbinden-und-infoseite', en: '18-Filamandb#187-connect-to-filaman-db-banner-and-info-page' },
  fdbSubmissions: { de: '27-Filaman-Db-Community#275-meine-einreichungen', en: '27-Filaman-Db-Community#275-my-submissions' },
  fdbSend: { de: '27-Filaman-Db-Community#273-an-filaman-db-senden', en: '27-Filaman-Db-Community#273-send-to-filaman-db' },

  settings: { de: '10-Einstellungen', en: '10-Settings' },
  settingsSidebar: { de: '10-Einstellungen#seitenleisten-einstellungen', en: '10-Settings#sidebar-settings' },
  settingsApiKeys: { de: '10-Einstellungen#api-keys', en: '10-Settings#api-keys' },
  settingsPassword: { de: '10-Einstellungen#passwort-andern', en: '10-Settings#change-password' },

  admin: { de: '11-Admin', en: '11-Admin' },
  adminUsers: { de: '11-Admin#111-benutzerverwaltung-users', en: '11-Admin#111-user-management-users' },
  adminRoles: { de: '11-Admin#112-rollen-berechtigungen-roles-permissions', en: '11-Admin#112-roles-permissions' },
  adminDevices: { de: '11-Admin#113-gerate-devices', en: '11-Admin#113-devices' },
  adminExtraFields: { de: '11-Admin#114-zusatzfelder-extra-fields', en: '11-Admin#114-extra-fields' },
  adminSystem: { de: '11-Admin#115-system-plugin-verwaltung', en: '11-Admin#115-system-plugin-management' },
  adminPluginInstall: { de: '11-Admin#plugin-installieren', en: '11-Admin#installing-a-plugin' },
  adminPluginDetails: { de: '11-Admin#plugin-details', en: '11-Admin#plugin-details' },
  adminBackup: { de: '11-Admin#116-datenbank-backup-wiederherstellung', en: '11-Admin#116-database-backup-restore' },
  adminOidc: { de: '11-Admin#117-oidc-sso', en: '11-Admin#117-oidc-sso' },
  adminAppSettings: { de: '11-Admin#118-app-einstellungen', en: '11-Admin#118-app-settings' },
  adminSpoolmanImport: { de: '11-Admin#1110-spoolman-import', en: '11-Admin#1110-spoolman-import' },
  adminFilamentDbImport: { de: '29-Plugin-Filamentdb', en: '29-Plugin-Filamentdb' },
} as const satisfies Record<string, HandbookTarget>

export type HandbookKey = keyof typeof handbookTargets

export function isHandbookKey(key: unknown): key is HandbookKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(handbookTargets, key)
}

/** German UI gets the German manual, every other language gets the English one. */
export function handbookLang(lang: string | null | undefined): HandbookLang {
  return (lang ?? '').toLowerCase().startsWith('de') ? 'de' : 'en'
}

const exactRoutes: Record<string, HandbookKey> = {
  '/': 'dashboard',
  '/login': 'login',
  '/spools': 'spools',
  '/spools/new': 'spoolAdd',
  '/spools/print': 'labels',
  '/spool-log': 'spoolLog',
  '/filaments': 'filaments',
  '/filaments/new': 'filamentAdd',
  '/filaments/print': 'labels',
  '/filaments/colors': 'colors',
  '/filament-picker': 'filaments',
  '/manufacturers': 'manufacturers',
  '/locations': 'locations',
  '/printers': 'printers',
  '/print-jobs': 'printJobs',
  '/analytics': 'analytics',
  '/display': 'amsView',
  '/filamentdb': 'filamentDb',
  '/settings': 'settings',
  '/settings/sidebar': 'settingsSidebar',
  '/settings/api-keys': 'settingsApiKeys',
  '/settings/slicer-link': 'slicerLink',
  '/settings/filamentdb-contributions': 'fdbSubmissions',
  '/admin': 'admin',
  '/admin/users': 'adminUsers',
  '/admin/roles': 'adminRoles',
  '/admin/devices': 'adminDevices',
  '/admin/extra-fields': 'adminExtraFields',
  '/admin/system': 'adminSystem',
  '/admin/backup': 'adminBackup',
  '/admin/oidc': 'adminOidc',
  '/admin/app-settings': 'adminAppSettings',
  '/admin/api-docs': 'admin',
  '/admin/system/spoolman-import': 'adminSpoolmanImport',
  '/admin/system/filamentdb-import': 'adminFilamentDbImport',
  '/admin/system/changelog': 'admin',
}

/** Dynamic routes: /spools/12, /spools/12/edit, /filaments/3/print, ... */
const patternRoutes: Array<[RegExp, HandbookKey]> = [
  [/^\/spools\/[^/]+\/print$/, 'labels'],
  [/^\/filaments\/[^/]+\/print$/, 'labels'],
  [/^\/spools\/[^/]+(\/edit)?$/, 'spoolDetail'],
  [/^\/filaments\/[^/]+(\/edit)?$/, 'filamentDetail'],
  [/^\/printers\/[^/]+$/, 'printerDetail'],
  [/^\/print-jobs\/[^/]+$/, 'printJobDetail'],
  [/^\/admin\/system\/.+$/, 'adminSystem'],
  [/^\/admin\/.+$/, 'admin'],
]

export function normalizePath(pathname: string): string {
  const path = (pathname || '/').split(/[?#]/)[0].replace(/\/index(\.html)?$/, '').replace(/\/+$/, '')
  return path || '/'
}

/** Maps a route to its context key; unknown routes fall back to the table of contents. */
export function routeToKey(pathname: string): HandbookKey {
  const path = normalizePath(pathname)
  if (Object.prototype.hasOwnProperty.call(exactRoutes, path)) return exactRoutes[path]
  for (const [pattern, key] of patternRoutes) if (pattern.test(path)) return key
  return 'contents'
}

export function handbookUrlForKey(key: string | null | undefined, lang: string | null | undefined): string {
  const target = handbookTargets[isHandbookKey(key) ? key : 'contents']
  const l = handbookLang(lang)
  return `${HANDBOOK_BASE}/Docs/${l === 'de' ? 'De' : 'En'}/${target[l]}`
}

export interface HandbookCandidate { key: string | null | undefined; depth: number; open: boolean }

/** Innermost open candidate with a known key; ties go to the later one in document order. */
export function pickHandbookKey(candidates: HandbookCandidate[]): HandbookKey | null {
  let best: HandbookKey | null = null
  let bestDepth = -1
  for (const c of candidates) {
    if (!c.open || !isHandbookKey(c.key) || c.depth < bestDepth) continue
    best = c.key
    bestDepth = c.depth
  }
  return best
}

function isOpen(el: Element): boolean {
  if (el instanceof HTMLDialogElement) return el.open
  if (el.classList.contains('open')) return true
  if (el.classList.contains('fm-modal-overlay')) return false
  return !(el as HTMLElement).hidden && el.getClientRects().length > 0
}

function depthOf(el: Element): number {
  let depth = 0
  for (let p = el.parentElement; p; p = p.parentElement) depth++
  return depth
}

/** Key of the innermost open dialog/drawer carrying `data-handbook`, if any. */
export function findOpenHandbookKey(root: ParentNode = document, open: (el: Element) => boolean = isOpen): HandbookKey | null {
  const candidates = Array.from(root.querySelectorAll('[data-handbook]')).map(el => ({
    key: el.getAttribute('data-handbook'),
    depth: depthOf(el),
    open: open(el),
  }))
  return pickHandbookKey(candidates)
}

export function getHandbookUrl(opts: { pathname: string; lang?: string | null; dialogKey?: string | null }): string {
  const key = isHandbookKey(opts.dialogKey) ? opts.dialogKey : routeToKey(opts.pathname)
  return handbookUrlForKey(key, opts.lang)
}
