export interface FilamentField {
  key: string
  labelKey: string
  kind: 'material' | 'text' | 'number' | 'url' | 'select' | 'checkbox' | 'range' | 'list'
  unit?: string
  id?: string
  required?: boolean
  step?: string
  min?: number
  max?: number
  maxLength?: number
  defaultValue?: string
  placeholder?: string
  placeholderKey?: string
  options?: Array<[value: string, labelKey: string]>
  rangePrefix?: string
  rangeLabel?: string
  display?: 'finish' | 'discontinued' | 'price'
  link?: boolean
  // Already represented by the hero name or the formatted price in read-only mode.
  editOnly?: boolean
}

export interface FilamentSection {
  key: string
  titleKey: string
  fields: FilamentField[]
}

export const filamentSections: FilamentSection[] = [
  {
    key: 'material', titleKey: 'filaments.materialDetails', fields: [
      { key: 'material_type', id: 'type', labelKey: 'filaments.type', kind: 'material', required: true },
      { key: 'diameter_mm', labelKey: 'filaments.diameter', kind: 'number', unit: 'mm', step: '0.01', defaultValue: '1.75', required: true },
      { key: 'material_subgroup', labelKey: 'filaments.materialSubgroup', kind: 'text', placeholderKey: 'filaments.materialSubgroupPlaceholder' },
      { key: 'finish_type', labelKey: 'filaments.finishType', kind: 'select', display: 'finish', options: [
        ['solid', 'filaments.finishSolid'], ['matte', 'filaments.finishMatte'], ['silk', 'filaments.finishSilk'],
        ['translucent', 'filaments.finishTranslucent'], ['neon', 'filaments.finishNeon'], ['glow', 'filaments.finishGlow'],
      ] },
      { key: 'designation', labelKey: 'filaments.designation', kind: 'text', required: true, editOnly: true, placeholderKey: 'filaments.designationPlaceholder' },
      { key: 'density_g_cm3', labelKey: 'filaments.densityLabel', kind: 'number', unit: 'g/cm³', step: '0.01', placeholderKey: 'filaments.densityPlaceholder' },
      { key: 'is_discontinued', labelKey: 'filaments.discontinued', kind: 'checkbox', display: 'discontinued' },
    ],
  },
  {
    key: 'spool', titleKey: 'filaments.spoolDetails', fields: [
      { key: 'raw_material_weight_g', labelKey: 'filaments.rawMaterialWeightLabel', kind: 'number', unit: 'g', step: '1', placeholderKey: 'filaments.rawMaterialPlaceholder' },
      { key: 'default_spool_weight_g', labelKey: 'filaments.defaultSpoolWeightLabel', kind: 'number', unit: 'g', step: '1', placeholderKey: 'filaments.defaultSpoolWeightPlaceholder' },
      { key: 'spool_material', labelKey: 'spools.spoolMaterial', kind: 'select', options: [
        ['Plastic', 'spools.spoolMaterialPlastic'], ['Cardboard', 'spools.spoolMaterialCardboard'],
        ['Metal', 'spools.spoolMaterialMetal'], ['Other', 'spools.spoolMaterialOther'],
      ] },
      { key: 'spool_outer_diameter_mm', labelKey: 'spools.spoolOuterDiameterLabel', kind: 'number', unit: 'mm', step: '0.1' },
      { key: 'spool_width_mm', labelKey: 'spools.spoolWidthLabel', kind: 'number', unit: 'mm', step: '0.1' },
      { key: 'price', labelKey: 'filaments.price', kind: 'number', step: '0.01', display: 'price', placeholderKey: 'filaments.pricePlaceholder' },
      { key: 'price_currency', labelKey: 'filaments.priceCurrency', kind: 'text', maxLength: 3, placeholder: 'USD', editOnly: true },
    ],
  },
  {
    key: 'temperatures', titleKey: 'filaments.temperatures', fields: [
      { key: 'extruder_temp_range_c', labelKey: 'filaments.extruderTemperatureLabel', kind: 'range', unit: '°C', rangePrefix: 'extruder_temp', rangeLabel: 'Extruder temperature' },
      { key: 'bed_temp_range_c', labelKey: 'filaments.bedTemperatureLabel', kind: 'range', unit: '°C', rangePrefix: 'bed_temp', rangeLabel: 'Bed temperature' },
      { key: 'chamber_temp_c', labelKey: 'filaments.chamberTemperatureLabel', kind: 'number', unit: '°C', step: 'any' },
      { key: 'softening_temp_c', labelKey: 'filaments.softeningTemperatureLabel', kind: 'number', unit: '°C', step: 'any' },
    ],
  },
  {
    key: 'drying', titleKey: 'filaments.dryingInfo', fields: [
      { key: 'drying_temp_c', labelKey: 'filaments.dryingTemperatureLabel', kind: 'number', unit: '°C', step: 'any' },
      { key: 'drying_time_hours', labelKey: 'filaments.dryingTimeLabel', kind: 'number', unit: 'h', step: 'any' },
    ],
  },
  {
    key: 'printBehavior', titleKey: 'filaments.printBehavior', fields: [
      { key: 'cooling_fan_range_percent', labelKey: 'filaments.coolingFanLabel', kind: 'range', unit: '%', rangePrefix: 'cooling_fan', rangeLabel: 'Cooling fan', min: 0, max: 100 },
      { key: 'max_volumetric_speed_mm3_s', labelKey: 'filaments.maxVolumetricSpeedLabel', kind: 'number', unit: 'mm³/s', step: 'any' },
      { key: 'flow_ratio', labelKey: 'filaments.flowRatio', kind: 'number', step: 'any' },
      { key: 'pressure_advance_k', labelKey: 'filaments.pressureAdvance', kind: 'number', step: 'any' },
    ],
  },
  {
    key: 'compatibilitySources', titleKey: 'filaments.compatibilitySources', fields: [
      { key: 'ams_compatibility', labelKey: 'filaments.amsCompatibility', kind: 'list', placeholder: 'AMS, AMS 2 Pro' },
      { key: 'build_plate_compatibility', labelKey: 'filaments.buildPlateCompatibility', kind: 'list', placeholder: 'Textured PEI, Smooth PEI' },
      { key: 'manufacturer_sku', labelKey: 'filaments.manufacturerSku', kind: 'text' },
      { key: 'shop_url', labelKey: 'filaments.shopUrl', kind: 'url', link: true, placeholderKey: 'filaments.shopUrlPlaceholder' },
      { key: 'datasheet_url', labelKey: 'filaments.datasheetUrl', kind: 'url', link: true },
      { key: 'image_url', labelKey: 'filaments.imageUrl', kind: 'url', link: true },
    ],
  },
]
