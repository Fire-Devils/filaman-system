/**
 * Druckermodell-Auswahl: Liste der FilaMan-DB, Suche und Fuzzy-Vorschläge
 * ("Meinten Sie …?") für Freitext-Eingaben.
 */

import { request } from './api'
import { fuzzyTokenScore } from './filamentdb-lookup'

export interface PrinterModelItem {
  id: number
  manufacturer: string
  model: string
  default_nozzle_mm?: number | null
}

export interface PrinterModelList {
  available: boolean
  items: PrinterModelItem[]
}

export const PRINTER_MODEL_SUGGEST_THRESHOLD = 0.6

export function printerModelLabel(item: { manufacturer?: string | null; model?: string | null }): string {
  return [item.manufacturer, item.model].filter(Boolean).join(' ').trim()
}

/** Lädt die Modellliste; ohne Plugin oder bei Fehlern kommt eine leere Liste. */
export async function fetchPrinterModels(): Promise<PrinterModelList> {
  try {
    const data = await request<PrinterModelList>('/filamentdb/printer-models')
    if (!data || data.available !== true || !Array.isArray(data.items)) return { available: false, items: [] }
    return { available: data.items.length > 0, items: data.items }
  } catch {
    return { available: false, items: [] }
  }
}

/** Einfache Teilstring-Suche über Hersteller + Modell (alle Wörter müssen vorkommen). */
export function filterPrinterModels(items: PrinterModelItem[], query: string, limit = 12): PrinterModelItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items.slice(0, limit)
  return items
    .filter(item => {
      const label = printerModelLabel(item).toLowerCase()
      return words.every(word => label.includes(word))
    })
    .slice(0, limit)
}

/**
 * Vorschläge für frei getippte Hersteller/Modell-Angaben, beste zuerst.
 * Leere Eingabe liefert nichts.
 */
export function suggestPrinterModels(
  items: PrinterModelItem[],
  manufacturer: string,
  model: string,
  limit = 3,
  threshold = PRINTER_MODEL_SUGGEST_THRESHOLD,
): PrinterModelItem[] {
  const typed = [manufacturer, model].join(' ').trim()
  if (!model.trim() && !manufacturer.trim()) return []
  return items
    .map(item => ({ item, score: fuzzyTokenScore(typed, printerModelLabel(item)) }))
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.item)
}
