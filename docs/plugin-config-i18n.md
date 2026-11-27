# Translating plugin config fields

Properties in a plugin manifest's `config_schema` are rendered as form fields in the printer dialogs. `title`, `description` and `enumNames` are written in English. A property may add optional translations under `x-i18n`, keyed by language code:

```json
"mode": {
  "type": "string",
  "title": "Mode",
  "description": "How slots are mapped.",
  "enum": ["toolhead_only", "tray_macros"],
  "enumNames": ["Toolhead only", "Tray macros"],
  "x-i18n": {
    "de": {
      "title": "Modus",
      "description": "Wie Slots zugeordnet werden.",
      "enumNames": ["Nur Toolhead", "Tray-Makros"]
    }
  }
}
```

Each sub-field is optional and falls back individually to the base value (`title` falls back to the property key). `enumNames` is only used when it is an array. All text is HTML-escaped.
