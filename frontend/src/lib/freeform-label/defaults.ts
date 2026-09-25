import type {
  LabelDesignV2,
  LabelElementIdFactory,
  LabelKind,
} from './types'
import { createLabelElementId } from './id'

export function createDefaultLabelDesign(
  kind: LabelKind,
  createId: LabelElementIdFactory = createLabelElementId,
): LabelDesignV2 {
  const subjectId = kind === 'filament' ? 'filament.id' : 'id'
  return {
    version: 2,
    label: {
      widthMm: 60,
      heightMm: 40,
      marginMm: 1,
      border: false,
    },
    elements: [
      {
        id: createId(),
        type: 'text',
        x: 3,
        y: 9,
        w: 34,
        h: 18,
        z: 0,
        template: `{filament.name}\n{filament.type} - #{${subjectId}}`,
        fontFamily: 'Space Grotesk',
        fontSizeMm: 3.2,
        fontWeight: 600,
        italic: false,
        underline: false,
        align: 'left',
        color: '#000000',
        wrap: true,
      },
      {
        id: createId(),
        type: 'qr',
        x: 39,
        y: 9,
        w: 18,
        h: 18,
        z: 1,
        mode: 'logo',
        linkMode: 'spool',
        urlTemplate: '',
      },
      {
        id: createId(),
        type: 'manufacturerLogo',
        x: 3,
        y: 2,
        w: 25,
        h: 5,
        z: 2,
        objectFit: 'contain',
        align: 'center',
      },
      {
        id: createId(),
        type: 'swatch',
        x: 3,
        y: 30,
        w: 54,
        h: 6,
        z: 3,
        radiusMm: 1,
      },
    ],
  }
}
