import * as pdfjs from "./vendor/pdf.min.mjs";

const {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFRawStream,
  PDFString,
  PDFHexString,
  decodePDFRawStream,
} = globalThis.PDFLib;
const assets = new URL("./vendor/", import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdf.worker.min.mjs",
  assets,
).href;
const maxPixels = 16_000_000;
const maxStream = 8 * 1024 * 1024;
const pricePattern = /^(?:[$€£]\s*)?\d[\d., ]{0,22}$/;
const fail = (message) => {
  throw new Error(message);
};

export async function openPDF(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL("standard_fonts/", assets).href,
    cMapUrl: new URL("cmaps/", assets).href,
    cMapPacked: true,
    wasmUrl: new URL("wasm/", assets).href,
    iccUrl: new URL("iccs/", assets).href,
    enableXfa: false,
    useSystemFonts: false,
    isEvalSupported: false,
    maxImageSize: maxPixels,
    stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    if (!pdf.numPages || pdf.numPages > 50)
      fail("Use a PDF with 1 to 50 pages.");
    return pdf;
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export async function indexPDF(pdf) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    if (viewport.width * viewport.height > maxPixels)
      fail("A page is too large to verify in the browser.");
    const content = await page.getTextContent({ disableNormalization: true });
    pages.push({
      items: content.items.filter((item) => item.str?.trim()),
      styles: content.styles,
      page,
    });
  }
  if (!pages.some(({ items }) => items.length))
    fail("This PDF has no selectable text. Use the original catalog PDF.");
  return pages;
}

// Keep byte offsets intact when reading PDF syntax. Text strings are decoded separately.
function byteString(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}

function fontCodec(font) {
  const mapStream = font?.lookup(PDFName.of("ToUnicode"));
  if (!(mapStream instanceof PDFRawStream)) {
    if (font?.get(PDFName.of("Subtype"))?.toString() === "/Type0") return null;
    return {
      decode: (value) => [...value],
      encode: (text) =>
        [...text].map((character) =>
          character.charCodeAt(0) <= 255 ? character : undefined,
        ),
    };
  }
  const cmap = byteString(decodePDFRawStream(mapStream).decode());
  if (cmap.length > 1_000_000) return null;
  const forward = new Map(),
    reverse = new Map();
  const fromHex = (hex) =>
    hex
      .match(/../g)
      .map((byte) => String.fromCharCode(parseInt(byte, 16)))
      .join("");
  const unicode = (hex) =>
    hex
      .match(/.{4}/g)
      ?.map((code) => String.fromCharCode(parseInt(code, 16)))
      .join("");
  function add(raw, decoded) {
    if (!decoded || raw.length % 2 || raw.length > 4) return;
    const key = fromHex(raw);
    forward.set(key, decoded);
    if (!reverse.has(decoded)) reverse.set(decoded, key);
  }
  for (const [, block] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, raw, decoded] of block.matchAll(
      /<([\da-f]+)>\s*<([\da-f]+)>/gi,
    ))
      add(raw, unicode(decoded));
  }
  for (const [, block] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, start, end, first, array] of block.matchAll(
      /<([\da-f]+)>\s*<([\da-f]+)>\s*(?:<([\da-f]+)>|\[([^\]]*)\])/gi,
    )) {
      const low = parseInt(start, 16),
        high = parseInt(end, 16);
      if (high - low > 4096) return null;
      const items = array ? [...array.matchAll(/<([\da-f]+)>/gi)] : [];
      for (let i = 0; i <= high - low; i++) {
        const raw = (low + i).toString(16).padStart(start.length, "0");
        const decoded = first
          ? unicode(
              (parseInt(first, 16) + i)
                .toString(16)
                .padStart(first.length, "0"),
            )
          : items[i] && unicode(items[i][1]);
        add(raw, decoded);
      }
    }
  }
  const widths = new Set([...forward.keys()].map((key) => key.length));
  if (widths.size !== 1) return null;
  const [width] = widths;
  return {
    decode(value) {
      if (value.length % width) return null;
      const chars = [];
      for (let i = 0; i < value.length; i += width) {
        const character = forward.get(value.slice(i, i + width));
        if (!character) return null;
        chars.push(character);
      }
      return chars;
    },
    encode: (value) => [...value].map((character) => reverse.get(character)),
  };
}

function textOperands(source, state, getCodec) {
  const tokens =
    /%[^\r\n]*|\((?:\\[\s\S]|[^\\()])*\)|<[\da-f\s]*>|<<|>>|[\[\]{}()]|\/[^\s<>[\](){}/%]+|[^\s<>[\](){}/%]+/gi;
  const values = [];
  let previous = [],
    array = null,
    closed = null;
  const part = (token, codec) => {
    const literal = token?.[0];
    if (
      !codec ||
      !(
        literal?.startsWith("(") ||
        (literal?.startsWith("<") && literal !== "<<")
      )
    )
      return null;
    const string =
      literal[0] === "("
        ? PDFString.of(literal.slice(1, -1))
        : PDFHexString.of(literal.slice(1, -1).replace(/\s/g, ""));
    const glyphs = codec.decode(byteString(string.asBytes()));
    return glyphs
      ? { glyphs, offset: token.index, length: literal.length }
      : null;
  };
  function record(tokens, codec) {
    const parts = tokens.map((token) => part(token, codec));
    if (parts.length && parts.every(Boolean))
      values.push({
        value: parts.flatMap(({ glyphs }) => glyphs).join(""),
        parts,
        codec,
      });
  }
  for (const token of source.matchAll(tokens)) {
    const value = token[0];
    if (value.startsWith("%")) continue;
    if (value === "BI" || value === "(" || value === ")")
      fail(
        "This page uses a content stream format that cannot be edited safely.",
      );
    if (value === "[") {
      array = [];
      continue;
    }
    if (value === "]") {
      closed = array;
      array = null;
    } else if (array) {
      array.push(token);
      continue;
    }
    if (value === "Tf") state.font = previous.at(-2)?.[0];
    if (value === "q") state.stack.push(state.font);
    if (value === "Q") state.font = state.stack.pop();
    if (["Tj", "'", '"'].includes(value))
      record([previous.at(-1)], getCodec(state.font));
    if (value === "TJ" && previous.at(-1)?.[0] === "]" && closed) {
      const codec = getCodec(state.font);
      let group = [];
      for (const item of closed) {
        if (/^[+-]?(?:\d|\.)/.test(item[0])) {
          // Large spacing adjustments separate fields within the same text operation.
          if (Math.abs(Number(item[0])) >= 150) {
            record(group, codec);
            group = [];
          }
        } else group.push(item);
      }
      record(group, codec);
    }
    previous.push(token);
    if (previous.length > 2) previous.shift();
  }
  return values;
}

function encodeEdits(operand, next) {
  const text = operand.value.replace(operand.value.trim(), next);
  const encoded = operand.codec.encode(text);
  if (encoded.some((character) => character === undefined))
    fail("The original PDF font cannot encode the new price.");
  let index = 0;
  return operand.parts.map(({ offset, length, glyphs }, part) => {
    const last = part === operand.parts.length - 1;
    const chunk = encoded.slice(
      index,
      last ? undefined : index + glyphs.length,
    );
    index += glyphs.length;
    const hex = [...chunk.join("")]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
    return { offset, length, hex: "<" + hex + ">" };
  });
}

function inspectDocument(document) {
  const visited = new WeakSet();
  const blocked = new Set([
    "/AA",
    "/JS",
    "/JavaScript",
    "/Launch",
    "/EmbeddedFiles",
    "/XFA",
    "/RichMedia",
    "/AcroForm",
  ]);
  function inspect(value) {
    if (value instanceof PDFName && blocked.has(value.toString()))
      fail("Use a PDF without forms, scripts, or embedded files.");
    if (
      !(
        value instanceof PDFDict ||
        value instanceof PDFArray ||
        value instanceof PDFRawStream
      ) ||
      visited.has(value)
    )
      return;
    visited.add(value);
    if (value instanceof PDFRawStream) inspect(value.dict);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        inspect(key);
        inspect(child);
      }
    } else for (let i = 0; i < value.size(); i++) inspect(value.get(i));
  }
  for (const [, object] of document.context.enumerateIndirectObjects())
    inspect(object);
}

function streams(document, pageNumber) {
  const page = document.getPage(pageNumber).node;
  const contents = page.Contents();
  const fonts = page.Resources()?.lookup(PDFName.of("Font"));
  const codecs = new Map();
  const state = { font: undefined, stack: [] };
  function getCodec(name) {
    if (!name?.startsWith("/") || !(fonts instanceof PDFDict)) return null;
    if (!codecs.has(name)) {
      const font = fonts.lookup(PDFName.of(name.slice(1)));
      codecs.set(name, font instanceof PDFDict ? fontCodec(font) : null);
    }
    return codecs.get(name);
  }
  const values =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i))
      : [contents];
  return values.map((stream) => {
    if (!(stream instanceof PDFRawStream))
      fail("This page has no editable text stream.");
    const bytes = decodePDFRawStream(stream).decode();
    if (bytes.length > maxStream)
      fail("This page's text stream is too large to edit safely.");
    const source = byteString(bytes);
    return {
      source,
      edits: [],
      operands: textOperands(source, state, getCodec),
    };
  });
}

function findCodes(items, code) {
  const matches = [];
  for (let start = 0; start < items.length; start++) {
    const first = items[start];
    let text = first.str.trim().replace(/\s+/g, " ");
    const group = [first];
    for (
      let i = start + 1;
      code.startsWith(text + " ") && i < items.length;
      i++
    ) {
      const next = items[i];
      const previous = items[i - 1];
      const gap = next.transform[4] - previous.transform[4] - previous.width;
      if (
        gap < -1 ||
        gap > Math.max(3, first.height * 0.65) ||
        Math.abs(next.transform[5] - first.transform[5]) > 1
      )
        break;
      text += " " + next.str.trim().replace(/\s+/g, " ");
      group.push(next);
    }
    if (text === code) matches.push(group);
  }
  return matches;
}

export async function review(bytes, pages, rows, choices = new Map()) {
  const document = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  inspectDocument(document);
  const streamCache = new Map();
  const codes = new Map();
  rows.forEach((row) => codes.set(row.sku, (codes.get(row.sku) ?? 0) + 1));
  return rows.map((row, index) => {
    const result = { ...row, index, status: "blocked", page: null };
    try {
      if (
        !row.sku ||
        !pricePattern.test(row.old) ||
        !pricePattern.test(row.next)
      )
        fail("Enter a product code and two valid prices.");
      if (codes.get(row.sku) > 1)
        fail("This product code appears more than once in the price sheet.");
      if (row.old === row.next)
        fail("The current and new prices are identical.");
      const code = row.sku.replace(/\s+/g, " ");
      const locations = pages.flatMap(({ items }, page) =>
        findCodes(items, code).map((group) => ({ page, group })),
      );
      if (locations.length !== 1)
        fail(
          locations.length
            ? "This product code appears more than once in the catalog."
            : "Product code not found as a separate text field.",
        );
      const { page, group } = locations[0];
      const [sku] = group;
      result.page = page;
      const { items, page: pdfPage } = pages[page];
      if (pdfPage.rotate) fail("Rotated pages are unsupported.");
      const [a, b, c, d, , y] = sku.transform;
      const hasBounds = row.left != null || row.right != null;
      if (
        hasBounds &&
        !(
          Number.isFinite(row.left) &&
          Number.isFinite(row.right) &&
          row.left >= 0 &&
          row.left < row.right
        )
      )
        fail("Check the price_left and price_right values.");
      if (b || c || a <= 0 || d <= 0)
        fail("This product code uses rotated text.");
      const candidates = items.flatMap((item, i) => {
        const [ta, tb, tc, td, tx, ty] = item.transform;
        return item.str.trim() === row.old &&
          !group.includes(item) &&
          (!hasBounds || (tx >= row.left && tx + item.width <= row.right)) &&
          !tb &&
          !tc &&
          ta > 0 &&
          td > 0 &&
          Math.abs(ty - y) <= Math.max(2, d * 0.35)
          ? [i]
          : [];
      });
      result.candidates = candidates;
      const position =
        candidates.length === 1 ? candidates[0] : choices.get(index);
      if (!candidates.includes(position))
        fail(
          candidates.length
            ? "Choose the intended price on this row."
            : "Current price not found as a separate field on this row.",
        );
      result.position = position;
      if (!streamCache.has(page))
        streamCache.set(page, streams(document, page));
      const streamsOnPage = streamCache.get(page);
      const operands = streamsOnPage.flatMap((stream, streamIndex) =>
        stream.operands
          .filter(({ value }) => value.trim() === row.old)
          .map((operand) => ({ ...operand, streamIndex })),
      );
      const matchingItems = items.flatMap((item, i) =>
        item.str.trim() === row.old ? [i] : [],
      );
      if (operands.length !== matchingItems.length || !operands.length)
        fail(
          "This PDF encodes the price in a format that cannot be replaced safely.",
        );
      const operand = operands[matchingItems.indexOf(position)];
      result.edits = encodeEdits(operand, row.next).map((edit) => ({
        ...edit,
        streamIndex: operand.streamIndex,
      }));
      result.status = "ready";
      return result;
    } catch (error) {
      result.reason = error.message;
      return result;
    }
  });
}

export async function render(page, canvas, scale) {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({
    canvas,
    viewport,
    annotationMode: pdfjs.AnnotationMode.DISABLE,
  }).promise;
  return viewport;
}

function comparePixels(original, updated, boxes, viewport) {
  const before = original
    .getContext("2d")
    .getImageData(0, 0, original.width, original.height).data;
  const after = updated
    .getContext("2d")
    .getImageData(0, 0, updated.width, updated.height).data;
  const masks = boxes.map(([x0, y0, x1, y1]) => {
    const [left, bottom] = viewport.convertToViewportPoint(x0, y0);
    const [right, top] = viewport.convertToViewportPoint(x1, y1);
    return [
      Math.floor(left) - 2,
      Math.floor(top) - 2,
      Math.ceil(right) + 2,
      Math.ceil(bottom) + 2,
    ];
  });
  for (let y = 0; y < original.height; y++) {
    for (let x = 0; x < original.width; x++) {
      const i = (y * original.width + x) * 4;
      if (
        before[i] === after[i] &&
        before[i + 1] === after[i + 1] &&
        before[i + 2] === after[i + 2] &&
        before[i + 3] === after[i + 3]
      )
        continue;
      if (!masks.some(([l, t, r, b]) => x >= l && x <= r && y >= t && y <= b))
        fail("Verification found a visual change outside the selected prices.");
    }
  }
}

export async function exportPDF(bytes, pages, rows, progress = () => {}) {
  if (!rows.length || rows.some((row) => row.status !== "ready"))
    fail("Resolve all flagged rows before saving.");
  const document = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  const byPage = Map.groupBy(rows, ({ page }) => page);
  for (const [number, edits] of byPage) {
    const content = streams(document, number);
    const occupied = new Set();
    for (const row of edits) {
      for (const edit of row.edits) {
        const key = edit.streamIndex + ":" + edit.offset;
        if (occupied.has(key))
          fail("Two changes point to the same price. Check the product rows.");
        occupied.add(key);
        content[edit.streamIndex].edits.push(edit);
      }
    }
    const replacement = document.context.obj([]);
    for (const stream of content) {
      let { source } = stream;
      for (const { offset, length, hex } of stream.edits.sort(
        (a, b) => b.offset - a.offset,
      )) {
        source = source.slice(0, offset) + hex + source.slice(offset + length);
      }
      replacement.push(
        document.context.register(
          document.context.flateStream(
            Uint8Array.from(source, (c) => c.charCodeAt(0)),
          ),
        ),
      );
    }
    document.getPage(number).node.set(PDFName.of("Contents"), replacement);
  }
  const output = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  const updated = await openPDF(output);
  const originalCanvas = documentCanvas();
  const updatedCanvas = documentCanvas();
  try {
    const checked = await indexPDF(updated);
    if (checked.length !== pages.length)
      fail("Verification found a changed page count.");
    for (let n = 0; n < pages.length; n++) {
      progress(n + 1, pages.length);
      const old = pages[n],
        next = checked[n];
      const edits = new Map(
        (byPage.get(n) ?? []).map((row) => [row.position, row]),
      );
      if (old.items.length !== next.items.length)
        fail("Verification found changed text layout.");
      const boxes = [];
      for (let i = 0; i < old.items.length; i++) {
        const before = old.items[i],
          after = next.items[i],
          edit = edits.get(i);
        const expected = edit ? edit.next : before.str.trim();
        if (
          after.str.trim() !== expected ||
          before.transform.some(
            (v, k) => Math.abs(v - after.transform[k]) > 0.05,
          )
        ) {
          fail(
            "Verification could not confirm the requested prices and positions.",
          );
        }
        if (edit) {
          const [, , , height, x, y] = before.transform;
          const width = Math.max(before.width, after.width);
          const right = old.items
            .filter(
              (item) =>
                item.transform[4] > x &&
                Math.abs(item.transform[5] - y) < height / 2,
            )
            .reduce(
              (nearest, item) => Math.min(nearest, item.transform[4]),
              old.page.view[2],
            );
          if (x + width > right - 1)
            fail("A new price does not fit in its original space.");
          boxes.push([
            x - 1,
            y - height * 0.35,
            x + width + 1,
            y + height * 1.05,
          ]);
        }
      }
      const viewport = await render(old.page, originalCanvas, 2);
      await render(next.page, updatedCanvas, 2);
      if (
        originalCanvas.width !== updatedCanvas.width ||
        originalCanvas.height !== updatedCanvas.height
      )
        fail("Verification found changed page dimensions.");
      comparePixels(originalCanvas, updatedCanvas, boxes, viewport);
    }
    return output;
  } finally {
    await updated.loadingTask.destroy();
    originalCanvas.width = updatedCanvas.width = 0;
  }
}

function documentCanvas() {
  return globalThis.document.createElement("canvas");
}
