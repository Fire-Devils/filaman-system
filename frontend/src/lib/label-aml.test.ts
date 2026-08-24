import { describe, expect, it } from 'vitest'

import {
  amlArchiveNameFromPngArchive,
  amlFilenameFromPng,
  buildLabelAml,
} from './label-aml'

describe('buildLabelAml', () => {
  it('writes one full-label PNG into LPAPI 1.6 XML', () => {
    const xml = buildLabelAml({
      name: 'PETG & Blue <test>',
      widthMm: 48,
      heightMm: 30,
      pngDataUrl: 'data:image/png;base64,cG5n',
      id: 123,
      objectId: 456,
    })

    expect(xml).toContain('<LPAPI version="1.6">')
    expect(xml).toContain(
      '<labelName>PETG &amp; Blue &lt;test&gt;</labelName>',
    )
    expect(xml).toContain('<labelWidth>48.000</labelWidth>')
    expect(xml).toContain('<labelHeight>30.000</labelHeight>')
    expect(xml).toContain('<validBoundsWidth>46</validBoundsWidth>')
    expect(xml).toContain('<validBoundsHeight>28</validBoundsHeight>')
    expect(xml).toContain('<content>cG5n</content>')
    expect(xml).toContain('<width>48.000</width>')
    expect(xml).toContain('<height>30.000</height>')
    expect(xml).toContain('<x>0.000</x>')
    expect(xml).toContain('<y>0.000</y>')
    expect(xml).toContain('<orientation>0.000000</orientation>')
    expect(xml).toContain('<id>123</id>')
    expect(xml).toContain('<objectId>456</objectId>')
    expect(xml.match(/<Image>/g)).toHaveLength(1)
  })

  it('escapes every XML-sensitive label-name character', () => {
    const xml = buildLabelAml({
      name: `A "quoted" 'label' & <tag>`,
      widthMm: 60,
      heightMm: 25,
      pngDataUrl: 'data:image/png;base64,YQ==',
      id: 1,
      objectId: 2,
    })

    expect(xml).toContain(
      '<labelName>A &quot;quoted&quot; &apos;label&apos; &amp; &lt;tag&gt;</labelName>',
    )
  })

  it.each([
    {
      widthMm: 0,
      heightMm: 30,
      pngDataUrl: 'data:image/png;base64,cG5n',
    },
    {
      widthMm: 48,
      heightMm: Number.NaN,
      pngDataUrl: 'data:image/png;base64,cG5n',
    },
    {
      widthMm: 48,
      heightMm: 30,
      pngDataUrl: 'data:image/jpeg;base64,cG5n',
    },
    {
      widthMm: 48,
      heightMm: 30,
      pngDataUrl: 'data:image/png;base64,',
    },
  ])('rejects invalid AML input %#', invalid => {
    expect(() => buildLabelAml({
      name: 'label',
      ...invalid,
    })).toThrow()
  })
})

describe('AML filenames', () => {
  it('mirrors PNG names and distinguishes AML archives', () => {
    expect(amlFilenameFromPng('label-2.png')).toBe('label-2.aml')
    expect(amlFilenameFromPng('label-2.PNG')).toBe('label-2.aml')
    expect(amlFilenameFromPng('label-2')).toBe('label-2.aml')
    expect(amlArchiveNameFromPngArchive('labels-2026-08-24.zip'))
      .toBe('labels-2026-08-24-aml.zip')
    expect(amlArchiveNameFromPngArchive('labels'))
      .toBe('labels-aml.zip')
  })
})
