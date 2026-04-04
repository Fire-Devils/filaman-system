import * as htmlToImage from "html-to-image";

type ExportSaveMode = "download" | "save-as";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

function readUint32BE(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) >>> 0) |
    ((bytes[offset + 1] << 16) >>> 0) |
    ((bytes[offset + 2] << 8) >>> 0) |
    (bytes[offset + 3] >>> 0)
  );
}

function writeUint32BE(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function isPng(bytes: Uint8Array) {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }

  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      return false;
    }
  }

  return true;
}

function getChunkType(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(chunkType: string, data: Uint8Array) {
  const typeBytes = new Uint8Array([
    chunkType.charCodeAt(0),
    chunkType.charCodeAt(1),
    chunkType.charCodeAt(2),
    chunkType.charCodeAt(3),
  ]);

  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);

  const chunk = new Uint8Array(12 + data.length);
  writeUint32BE(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32BE(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

async function setPngDpiMetadata(pngBlob: Blob, dpi: number) {
  const bytes = new Uint8Array(await pngBlob.arrayBuffer());
  if (!isPng(bytes)) {
    return pngBlob;
  }

  const pixelsPerMeter = Math.max(1, Math.round(dpi / 0.0254));
  const physData = new Uint8Array(9);
  writeUint32BE(physData, 0, pixelsPerMeter);
  writeUint32BE(physData, 4, pixelsPerMeter);
  physData[8] = 1;
  const physChunk = createPngChunk("pHYs", physData);

  const chunks: Uint8Array[] = [bytes.slice(0, 8)];
  let offset = 8;
  let insertedPhys = false;
  let removedExistingPhys = false;

  while (offset + 8 <= bytes.length) {
    const chunkLength = readUint32BE(bytes, offset);
    const chunkTotalSize = 12 + chunkLength;
    if (offset + chunkTotalSize > bytes.length) {
      return pngBlob;
    }

    const chunkType = getChunkType(bytes, offset + 4);
    const fullChunk = bytes.slice(offset, offset + chunkTotalSize);

    if (chunkType === "pHYs") {
      removedExistingPhys = true;
      offset += chunkTotalSize;
      continue;
    }

    if (!insertedPhys && chunkType === "IHDR") {
      chunks.push(fullChunk);
      chunks.push(physChunk);
      insertedPhys = true;
    } else if (
      !insertedPhys &&
      (chunkType === "IDAT" || chunkType === "IEND")
    ) {
      chunks.push(physChunk);
      chunks.push(fullChunk);
      insertedPhys = true;
    } else {
      chunks.push(fullChunk);
    }

    offset += chunkTotalSize;
  }

  if (!insertedPhys && !removedExistingPhys) {
    return pngBlob;
  }

  return new Blob(
    chunks.map((chunk) => chunk as unknown as BlobPart),
    { type: "image/png" },
  );
}

function downloadBlob(filename: string, blob: Blob) {
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

async function saveBlobWithPicker(filename: string, blob: Blob) {
  // Prefer an explicit save dialog when the browser exposes the File System Access API.
  const picker = (
    window as typeof window & {
      showSaveFilePicker?: (options?: {
        suggestedName?: string;
        types?: Array<{
          description?: string;
          accept: Record<string, string[]>;
        }>;
      }) => Promise<{
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;

  if (!picker) {
    downloadBlob(filename, blob);
    return;
  }

  const extension = filename.split(".").pop()?.toLowerCase() ?? "bin";
  const mimeType = blob.type || "application/octet-stream";
  const handle = await picker({
    suggestedName: filename,
    types: [
      {
        description: extension.toUpperCase(),
        accept: {
          [mimeType]: [`.${extension}`],
        },
      },
    ],
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveBlob(
  filename: string,
  blob: Blob,
  saveMode: ExportSaveMode,
) {
  if (saveMode === "save-as") {
    await saveBlobWithPicker(filename, blob);
    return;
  }

  // Standard click export falls back to the browser's configured download folder.
  downloadBlob(filename, blob);
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildAmlPageXml(widthMm: number, heightMm: number, base64Png: string) {
  const id = Math.floor(Math.random() * 2 ** 31);
  const objectId = Math.floor(Math.random() * 2 ** 31);

  return `<WdPage>
            <masksToBoundsType>0</masksToBoundsType>
            <borderDisplay>0</borderDisplay>
            <isAutoHeight>0</isAutoHeight>
            <lineType>0</lineType>
            <borderWidth>1</borderWidth>
            <borderColor>#000000</borderColor>
            <lockMovement>0</lockMovement>
            <contents><Image>
                  <lineType>0</lineType>
                  <content>${base64Png}</content>
                  <height>${heightMm.toFixed(3)}</height>
                  <width>${widthMm.toFixed(3)}</width>
                  <y>0.000</y>
                  <x>0.000</x>
                  <orientation>0.000000</orientation>
                  <lockMovement>0</lockMovement>
                  <borderDisplay>0</borderDisplay>
                  <borderHeight>0.7055555449591742</borderHeight>
                  <borderWidth>0.7055555449591742</borderWidth>
                  <borderColor>#000000</borderColor>
                  <id>${id}</id>
                  <objectId>${objectId}</objectId>
                  <imageEffect>0</imageEffect>
                  <antiColor>0</antiColor>
                  <isRatioScale>1</isRatioScale>
                  <imageType>0</imageType>
                  <isMirror>0</isMirror>
                  <isRedBlack>0</isRedBlack>
            </Image></contents>
            <columnCount>0</columnCount>
            <isRibbonLabel>0</isRibbonLabel>
      </WdPage>`;
}

function buildAmlXml(
  name: string,
  widthMm: number,
  heightMm: number,
  base64Png: string,
) {
  const validBoundsWidth = Math.max(widthMm - 2, 0);
  const validBoundsHeight = Math.max(heightMm - 2, 0);
  const widthIn = widthMm / 25.4;
  const heightIn = heightMm / 25.4;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<LPAPI version="1.6">
  <labelName>${escapeXml(name)}</labelName>
  <paperName>Custom Label</paperName>
  <isPrintHorizontal>0</isPrintHorizontal>
  <labelHeight>${heightMm.toFixed(3)}</labelHeight>
  <labelWidth>${widthMm.toFixed(3)}</labelWidth>
  <validBoundsX>1</validBoundsX>
  <validBoundsY>1</validBoundsY>
  <validBoundsWidth>${validBoundsWidth.toFixed(0)}</validBoundsWidth>
  <validBoundsHeight>${validBoundsHeight.toFixed(0)}</validBoundsHeight>
  <paperType>0</paperType>
  <paperBackground>#ffffff</paperBackground>
  <paperForeground>#000000</paperForeground>
  <DisplaySize_mm>${widthMm.toFixed(2)}mm * ${heightMm.toFixed(2)}mm</DisplaySize_mm>
  <DisplaySize_in>${widthIn.toFixed(3)}inch * ${heightIn.toFixed(3)}inch</DisplaySize_in>
  <isRotate180>0</isRotate180>
  <isBannerMode>0</isBannerMode>
  <isCustomSize>0</isCustomSize>
  <leftBlank>0</leftBlank>
  <rightBlank>0</rightBlank>
  <upBlank>0</upBlank>
  <downBlank>0</downBlank>
  <typeName>Custom</typeName>
  <showDisplayMm>${widthMm.toFixed(1)} * ${heightMm.toFixed(1)} mm</showDisplayMm>
  <showDisplayIn>${widthIn.toFixed(2)} * ${heightIn.toFixed(2)} in</showDisplayIn>
  <contents>
    ${buildAmlPageXml(widthMm, heightMm, base64Png)}
  </contents>
</LPAPI>
`;
}

async function captureLabelBlob(element: HTMLElement, dpi: number) {
  element.classList.add("is-exporting-label");

  try {
    const url = await htmlToImage.toPng(element, {
      backgroundColor: "#ffffff",
      cacheBust: true,
      pixelRatio: Math.max(1, Math.min(dpi / 96, 10)),
    });
    const response = await fetch(url);
    const blob = await response.blob();
    return await setPngDpiMetadata(blob, dpi);
  } finally {
    element.classList.remove("is-exporting-label");
  }
}

export function sanitizeFilename(value: string) {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }

  return trimmed
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "");
}

export function buildPlannedFileName(
  parts: Array<string | null | undefined>,
  fallback: string,
) {
  const joined = parts
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" - ");

  return sanitizeFilename(joined) || fallback;
}

export async function exportLabelAsPng(
  element: HTMLElement,
  fileName: string,
  dpi: number,
  saveMode: ExportSaveMode = "download",
) {
  const pngBlob = await captureLabelBlob(element, dpi);
  await saveBlob(`${fileName}.png`, pngBlob, saveMode);
}

export async function exportLabelAsAml(
  element: HTMLElement,
  fileName: string,
  dpi: number,
  widthMm: number,
  heightMm: number,
  saveMode: ExportSaveMode = "download",
) {
  const pngBlob = await captureLabelBlob(element, dpi);
  const dataUrl = await blobToDataUrl(pngBlob);
  const base64 = dataUrl.split(",")[1] ?? "";
  const aml = buildAmlXml(fileName, widthMm, heightMm, base64);
  await saveBlob(
    `${fileName}.aml`,
    new Blob([aml], { type: "application/xml" }),
    saveMode,
  );
}
