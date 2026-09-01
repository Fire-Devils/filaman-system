export interface LabelAmlInput {
  name: string
  widthMm: number
  heightMm: number
  pngDataUrl: string
  id?: number
  objectId?: number
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function makePositiveId() {
  const values = new Uint32Array(1)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values)
    return Math.max(1, values[0] & 0x7fffffff)
  }
  return Math.max(1, Math.floor(Math.random() * 0x7fffffff))
}

function requirePngBase64(dataUrl: string) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    dataUrl,
  )
  if (!match) {
    throw new Error('AML export requires a non-empty PNG data URL')
  }
  return match[1]
}

function requireDimension(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`AML ${name} must be a positive finite number`)
  }
  return value
}

export function buildLabelAml(input: LabelAmlInput) {
  const width = requireDimension(input.widthMm, 'width')
  const height = requireDimension(input.heightMm, 'height')
  const base64Png = requirePngBase64(input.pngDataUrl)
  const id = input.id ?? makePositiveId()
  const objectId = input.objectId ?? makePositiveId()
  const validBoundsWidth = Math.max(width - 2, 0)
  const validBoundsHeight = Math.max(height - 2, 0)
  const widthIn = width / 25.4
  const heightIn = height / 25.4

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<LPAPI version="1.6">
  <labelName>${escapeXml(input.name)}</labelName>
  <paperName>Custom Label</paperName>
  <isPrintHorizontal>0</isPrintHorizontal>
  <labelHeight>${height.toFixed(3)}</labelHeight>
  <labelWidth>${width.toFixed(3)}</labelWidth>
  <validBoundsX>1</validBoundsX>
  <validBoundsY>1</validBoundsY>
  <validBoundsWidth>${validBoundsWidth.toFixed(0)}</validBoundsWidth>
  <validBoundsHeight>${validBoundsHeight.toFixed(0)}</validBoundsHeight>
  <paperType>0</paperType>
  <paperBackground>#ffffff</paperBackground>
  <paperForeground>#000000</paperForeground>
  <DisplaySize_mm>${width.toFixed(2)}mm * ${height.toFixed(2)}mm</DisplaySize_mm>
  <DisplaySize_in>${widthIn.toFixed(3)}inch * ${heightIn.toFixed(3)}inch</DisplaySize_in>
  <isRotate180>0</isRotate180>
  <isBannerMode>0</isBannerMode>
  <isCustomSize>0</isCustomSize>
  <leftBlank>0</leftBlank>
  <rightBlank>0</rightBlank>
  <upBlank>0</upBlank>
  <downBlank>0</downBlank>
  <typeName>Custom</typeName>
  <showDisplayMm>${width.toFixed(1)} * ${height.toFixed(1)} mm</showDisplayMm>
  <showDisplayIn>${widthIn.toFixed(2)} * ${heightIn.toFixed(2)} in</showDisplayIn>
  <contents>
    <WdPage>
      <masksToBoundsType>0</masksToBoundsType>
      <borderDisplay>0</borderDisplay>
      <isAutoHeight>0</isAutoHeight>
      <lineType>0</lineType>
      <borderWidth>1</borderWidth>
      <borderColor>#000000</borderColor>
      <lockMovement>0</lockMovement>
      <contents>
        <Image>
          <lineType>0</lineType>
          <content>${base64Png}</content>
          <height>${height.toFixed(3)}</height>
          <width>${width.toFixed(3)}</width>
          <y>0.000</y>
          <x>0.000</x>
          <orientation>0.000000</orientation>
          <lockMovement>0</lockMovement>
          <borderDisplay>0</borderDisplay>
          <borderHeight>0.7055555449591742</borderHeight>
          <borderColor>#000000</borderColor>
          <id>${id}</id>
          <objectId>${objectId}</objectId>
          <imageEffect>0</imageEffect>
          <antiColor>0</antiColor>
          <isRatioScale>1</isRatioScale>
          <imageType>0</imageType>
          <isMirror>0</isMirror>
          <isRedBlack>0</isRedBlack>
        </Image>
      </contents>
      <columnCount>0</columnCount>
      <isRibbonLabel>0</isRibbonLabel>
    </WdPage>
  </contents>
</LPAPI>
`
}

export function amlFilenameFromPng(filename: string) {
  return /\.png$/i.test(filename)
    ? filename.replace(/\.png$/i, '.aml')
    : `${filename}.aml`
}

export function amlArchiveNameFromPngArchive(filename: string) {
  return /\.zip$/i.test(filename)
    ? filename.replace(/\.zip$/i, '-aml.zip')
    : `${filename}-aml.zip`
}
