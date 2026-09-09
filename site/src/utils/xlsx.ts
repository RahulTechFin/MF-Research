// src/utils/xlsx.ts — write a real .xlsx, with no dependencies.
//
// WHY HAND-ROLLED
// An .xlsx is a ZIP of XML parts, and this project has no spreadsheet library
// and no build step that could add one. The alternatives were both worse than
// writing it: a CSV loses every bit of formatting (a column of 0.0096 that
// should read 0.96%, and no way to tell a header from a total), and the
// "HTML table served as .xls" trick makes Excel open with a
// "the file format doesn't match the extension" warning every single time.
//
// So this produces a genuine, valid workbook: bold headers on a dark fill, a
// frozen header row, real percentage cells, sensible column widths, and a
// title block naming the desk, the section and the as-of date so the file still
// makes sense a month later in someone's Downloads folder.
//
// HOW THE ZIP IS BUILT
// Entries are STORED, not deflated. Excel accepts stored entries, and it means
// no compression code is needed — the whole container is a few hundred bytes of
// headers plus the XML. A dashboard export is tens of kilobytes; the size saved
// by deflating is not worth a second implementation of anything.
//
// Verified by generating a workbook and reading it back with openpyxl, not by
// assuming the bytes are right.

// ── ZIP ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry { name: string; data: Uint8Array }

/**
 * A ZIP archive with every entry stored uncompressed.
 *
 * The DOS timestamp in the ZIP headers is fixed rather than "now", so two
 * workbooks built from the same data differ only where they should: the
 * generation time inside docProps/core.xml. That keeps the ZIP layer boring and
 * puts the one moving value somewhere a person can actually read it.
 */
function zipStore(entries: ZipEntry[]): Uint8Array {
  const DOS_TIME = 0        // 00:00:00
  const DOS_DATE = 0x2821   // 2000-01-01
  const enc = new TextEncoder()

  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)   // local file header signature
    lv.setUint16(4, 20, true)           // version needed
    lv.setUint16(6, 0, true)            // flags
    lv.setUint16(8, 0, true)            // method 0 = stored
    lv.setUint16(10, DOS_TIME, true)
    lv.setUint16(12, DOS_DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, e.data.length, true)   // compressed size
    lv.setUint32(22, e.data.length, true)   // uncompressed size
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)               // extra length
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)   // central directory signature
    cv.setUint16(4, 20, true)           // version made by
    cv.setUint16(6, 20, true)           // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, DOS_TIME, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, e.data.length, true)
    cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true)           // extra
    cv.setUint16(32, 0, true)           // comment
    cv.setUint16(34, 0, true)           // disk number
    cv.setUint16(36, 0, true)           // internal attrs
    cv.setUint32(38, 0, true)           // external attrs
    cv.setUint32(42, offset, true)      // offset of the local header
    central.set(name, 46)

    locals.push(local, e.data)
    centrals.push(central)
    offset += local.length + e.data.length
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)     // end of central directory
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const parts = [...locals, ...centrals, end]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ── the workbook ─────────────────────────────────────────────────────────────

/** Style slots defined in styles.xml below, in the order they appear there. */
const S = {
  DEFAULT: 0,
  TITLE: 1,
  BOLD: 2,
  HEADER: 3,
  TEXT: 4,
  PERCENT: 5,
  NUMBER: 6,
  GROUP: 7,
} as const

export type CellType = 'text' | 'percent' | 'number' | 'int'

export interface Column {
  /** Key into each row object. */
  key: string
  /** Column heading. */
  label: string
  type?: CellType
  /** Character width. Defaults by type. */
  width?: number
}

export interface Row {
  /** A full-width subheading (a category or an asset class), not a data row. */
  group?: string
  [key: string]: unknown
}

export interface SheetSpec {
  /** Tab name. Excel forbids : \ / ? * [ ] and caps it at 31 characters. */
  sheet: string
  /** Bold line at the top of the sheet. */
  title: string
  /** Label/value lines under the title — desk, category, as-of, notes. */
  meta?: [string, string][]
  columns: Column[]
  rows: Row[]
  /** File name, without the extension. */
  fileName: string
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!
  ))
}

/** 1 -> A, 26 -> Z, 27 -> AA. Needed because the annual view runs past Z. */
export function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function cell(ref: string, value: unknown, type: CellType, style: number): string {
  if (value === null || value === undefined || value === '') {
    // An empty cell, not a zero. A missing return and a return of nought are
    // different facts and must not look the same in a spreadsheet.
    return `<c r="${ref}" s="${style}"/>`
  }
  if (type !== 'text' && typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">`
    + esc(String(value)) + `</t></is></c>`
}

function styleFor(type: CellType | undefined): number {
  if (type === 'percent') return S.PERCENT
  if (type === 'number' || type === 'int') return S.NUMBER
  return S.TEXT
}

function defaultWidth(c: Column): number {
  if (c.width) return c.width
  if (!c.type || c.type === 'text') return 34
  return Math.max(11, c.label.length + 3)
}

// ── Document properties ──────────────────────────────────────────────────────
//
// Excel shows this in File > Info and in the Details tab of the file's Windows
// properties, and it is what appears as "Authors" in a folder listing. Without a
// docProps/core.xml part there is no author at all, and a file that circulates
// with a blank author looks like it came from nowhere.
//
// One constant, so changing it changes every export.
export const DOCUMENT_AUTHOR = 'Ashvin'
export const DOCUMENT_COMPANY = 'Armstrong Capital'
export const DOCUMENT_APPLICATION = 'Armstrong MF Research'

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

/** dcterms wants a W3CDTF timestamp, which is ISO 8601 to whole seconds in UTC. */
function w3cdtf(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function coreProps(title: string): string {
  const now = w3cdtf(new Date())
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title>
<dc:creator>${esc(DOCUMENT_AUTHOR)}</dc:creator>
<cp:lastModifiedBy>${esc(DOCUMENT_AUTHOR)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>${esc(DOCUMENT_APPLICATION)}</Application>
<Company>${esc(DOCUMENT_COMPANY)}</Company>
</Properties>`

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

// numFmtId 10 is Excel's built-in 0.00%. 164 is the first id available for a
// custom format, used here for a 4-decimal NAV.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0000"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF1E3A8A"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

/** Excel rejects a tab name over 31 chars or containing : \ / ? * [ ] */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Sheet1'
  return cleaned.slice(0, 31)
}

export function buildWorkbook(spec: SheetSpec): Uint8Array {
  const enc = new TextEncoder()
  const cols = spec.columns
  const lines: string[] = []
  let r = 0

  const put = (row: string) => lines.push(row)

  // Title
  r++
  put(`<row r="${r}"><c r="A${r}" s="${S.TITLE}" t="inlineStr"><is><t>`
    + esc(spec.title) + `</t></is></c></row>`)

  // Meta block: label in column A, value in column B.
  for (const [k, v] of spec.meta ?? []) {
    r++
    put(`<row r="${r}">`
      + `<c r="A${r}" s="${S.BOLD}" t="inlineStr"><is><t>${esc(k)}</t></is></c>`
      + `<c r="B${r}" s="${S.TEXT}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
      + `</row>`)
  }

  r++   // one blank spacer row
  const headerRow = ++r
  put(`<row r="${headerRow}" ht="30" customHeight="1">`
    + cols.map((c, i) => `<c r="${colLetter(i + 1)}${headerRow}" s="${S.HEADER}" `
        + `t="inlineStr"><is><t>${esc(c.label)}</t></is></c>`).join('')
    + `</row>`)

  for (const row of spec.rows) {
    r++
    if (row.group !== undefined) {
      // A subheading spanning the sheet. Written as one styled cell plus empty
      // styled cells across the row, so the fill runs the full width instead of
      // stopping after the text.
      put(`<row r="${r}">`
        + `<c r="A${r}" s="${S.GROUP}" t="inlineStr"><is><t>${esc(row.group)}</t></is></c>`
        + cols.slice(1).map((_c, i) =>
            `<c r="${colLetter(i + 2)}${r}" s="${S.GROUP}"/>`).join('')
        + `</row>`)
      continue
    }
    put(`<row r="${r}">`
      + cols.map((c, i) => cell(`${colLetter(i + 1)}${r}`, row[c.key],
                                c.type ?? 'text', styleFor(c.type))).join('')
      + `</row>`)
  }

  const dim = `A1:${colLetter(cols.length)}${Math.max(r, headerRow)}`
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dim}"/>
<sheetViews><sheetView workbookViewId="0">`
    // Freeze everything above the first data row, so the headings stay put
    // however far down a 2,000-fund export you scroll.
    + `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`
    + `</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols.map((c, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${defaultWidth(c)}" customWidth="1"/>`).join('')}</cols>
<sheetData>${lines.join('')}</sheetData>
<autoFilter ref="${colLetter(1)}${headerRow}:${colLetter(cols.length)}${Math.max(r, headerRow)}"/>
</worksheet>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(safeSheetName(spec.sheet))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(CT) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: 'docProps/core.xml', data: enc.encode(coreProps(spec.title)) },
    { name: 'docProps/app.xml', data: enc.encode(APP_PROPS) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(WB_RELS) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
  ])
}

/** Build and hand it to the browser. */
export function downloadWorkbook(spec: SheetSpec): void {
  const bytes = buildWorkbook(spec)
  // Copy into a fresh ArrayBuffer: Blob rejects the SharedArrayBuffer-compatible
  // type that Uint8Array infers under some TS configurations.
  const buf = new ArrayBuffer(bytes.length)
  new Uint8Array(buf).set(bytes)
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${spec.fileName}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick, not immediately: Safari cancels an in-flight
  // download if the object URL disappears in the same frame as the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
