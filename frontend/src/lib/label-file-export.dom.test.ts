// @vitest-environment happy-dom

import JSZip from 'jszip'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { downloadLabelFiles } from './label-file-export'

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:label-export'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('downloadLabelFiles', () => {
  it('downloads one PNG through its original data URL', async () => {
    const clicks: Array<{ name: string; href: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        clicks.push({ name: this.download, href: this.href })
      })

    await downloadLabelFiles([{
      name: 'label-1.png',
      contents: 'cG5n',
      directUrl: 'data:image/png;base64,cG5n',
      zipBase64: true,
      mimeType: 'image/png',
    }], 'labels.zip')

    expect(clicks).toEqual([{
      name: 'label-1.png',
      href: 'data:image/png;base64,cG5n',
    }])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('downloads one AML through an XML Blob URL', async () => {
    let createdBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      createdBlob = value as Blob
      return 'blob:aml'
    })
    const clicks: Array<{ name: string; href: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        clicks.push({ name: this.download, href: this.href })
      })

    await downloadLabelFiles([{
      name: 'label-1.aml',
      contents: '<LPAPI version="1.6"/>',
      mimeType: 'application/xml',
    }], 'labels-aml.zip')

    expect(clicks).toEqual([{
      name: 'label-1.aml',
      href: 'blob:aml',
    }])
    expect(createdBlob?.type).toBe('application/xml')
    expect(await createdBlob?.text()).toBe('<LPAPI version="1.6"/>')
  })

  it('packages multiple AML records in one named ZIP', async () => {
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:zip'
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push(this.download)
      })

    await downloadLabelFiles([
      {
        name: 'one.aml',
        contents: '<one/>',
        mimeType: 'application/xml',
      },
      {
        name: 'two.aml',
        contents: '<two/>',
        mimeType: 'application/xml',
      },
    ], 'labels-aml.zip')

    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    expect(downloads).toEqual(['labels-aml.zip'])
    expect(Object.keys(zip.files)).toEqual(['one.aml', 'two.aml'])
    expect(await zip.file('two.aml')!.async('text')).toBe('<two/>')
  })

  it('keeps a surviving batch file in an archive when requested', async () => {
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:partial-zip'
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) {
        downloads.push(this.download)
      })

    await downloadLabelFiles([{
      name: 'survivor.png',
      contents: 'cG5n',
      directUrl: 'data:image/png;base64,cG5n',
      zipBase64: true,
      mimeType: 'image/png',
    }], 'labels.zip', { forceArchive: true })

    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    expect(downloads).toEqual(['labels.zip'])
    expect(Object.keys(zip.files)).toEqual(['survivor.png'])
  })

  it('suffixes duplicate archive entry names deterministically', async () => {
    let archiveBlob: Blob | undefined
    vi.mocked(URL.createObjectURL).mockImplementation(value => {
      archiveBlob = value as Blob
      return 'blob:zip'
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    await downloadLabelFiles([
      {
        name: 'label.aml',
        contents: '<one/>',
        mimeType: 'application/xml',
      },
      {
        name: 'label.aml',
        contents: '<two/>',
        mimeType: 'application/xml',
      },
      {
        name: 'label.aml',
        contents: '<three/>',
        mimeType: 'application/xml',
      },
    ], 'labels-aml.zip')

    const zip = await JSZip.loadAsync(await archiveBlob!.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual([
      'label.aml',
      'label-01.aml',
      'label-02.aml',
    ])
    expect(await zip.file('label-02.aml')!.async('text'))
      .toBe('<three/>')
  })

  it('does not download an empty collection', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    await downloadLabelFiles([], 'labels.zip')

    expect(click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
