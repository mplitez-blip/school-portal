import type { Resource } from '@school-portal/shared';
import { formatFileSize, getFileDownloadUrl } from './api';

export type PreviewKind = 'pdf' | 'docx' | 'xlsx' | 'xlsm';

export interface PdfPreviewData {
  kind: 'pdf';
  pageCount: number;
  thumbnailDataUrl: string;
  bytes: Uint8Array;
}

export interface DocxPreviewData {
  kind: 'docx';
  bytes: Uint8Array;
}

export interface SheetCellData {
  text: string;
  colSpan: number;
  rowSpan: number;
  isNumeric: boolean;
  isMultiline: boolean;
  isTitleSpan: boolean;
}

export interface SheetGridRow {
  rowNumber: number;
  cells: Array<SheetCellData | null>; // null = skipped because covered by a merge
}

export interface SheetGridData {
  name: string;
  colWidths: number[];
  colLabels: string[];
  rows: SheetGridRow[];
  totalRows: number;
  totalCols: number;
}

export interface SpreadsheetPreviewData {
  kind: 'xlsx' | 'xlsm';
  sheets: SheetGridData[];
}

export type PreviewData = PdfPreviewData | DocxPreviewData | SpreadsheetPreviewData;

const AUTO_PREVIEW_MAX_BYTES = 10 * 1024 * 1024; // Auto-load previews up to 10 MB
const CARD_SHEET_MAX_ROWS = 28;
const CARD_SHEET_MAX_COLS = 14;
const MODAL_SHEET_MAX_ROWS = 100;
const MODAL_SHEET_MAX_COLS = 26;
const MIN_VIRTUAL_SHEET_WIDTH = 920;
const MAX_CARD_SHEET_WIDTH = 1320;

const previewCache = new Map<string, Promise<PreviewData>>();

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
let docxPreviewPromise: Promise<typeof import('docx-preview')> | null = null;
let xlsxPromise: Promise<typeof import('xlsx')> | null = null;
let docxScopeCounter = 0;

export function detectPreviewKind(resource: Resource): PreviewKind | null {
  if (resource.type !== 'file') return null;
  const name = (resource.fileName || '').toLowerCase();
  const mime = (resource.mimeType || '').toLowerCase();

  if (name.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (
    name.endsWith('.docx') ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (name.endsWith('.xlsm') || mime === 'application/vnd.ms-excel.sheet.macroenabled.12') {
    return 'xlsm';
  }
  if (
    name.endsWith('.xlsx') ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'xlsx';
  }
  return null;
}

async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjsLib, workerMod]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerMod.default;
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

async function loadDocxPreview(): Promise<typeof import('docx-preview')> {
  docxPreviewPromise ??= import('docx-preview');
  return docxPreviewPromise;
}

async function loadXlsx(): Promise<typeof import('xlsx')> {
  xlsxPromise ??= import('xlsx');
  return xlsxPromise;
}

function columnIndexToLetter(index: number): string {
  let n = index;
  let result = '';
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

async function renderPdfPageToCanvas(
  pdfBytes: Uint8Array,
  pageNumber: number,
  targetWidth: number
): Promise<{ canvas: HTMLCanvasElement; pageCount: number }> {
  const pdfjsLib = await loadPdfjs();
  // Always slice bytes because pdf.js transfers the underlying ArrayBuffer to its worker
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
  const pdf = await loadingTask.promise;
  try {
    const clampedPage = Math.min(Math.max(1, pageNumber), pdf.numPages);
    const page = await pdf.getPage(clampedPage);
    const baseViewport = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (targetWidth / Math.max(baseViewport.width, 1)) * dpr;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context unavailable.');

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return { canvas, pageCount: pdf.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

function extractSheetGrid(
  XLSX: typeof import('xlsx'),
  sheet: import('xlsx').WorkSheet,
  name: string
): SheetGridData {
  const ref = sheet['!ref'];
  if (!ref) {
    return { name, colWidths: [], colLabels: [], rows: [], totalRows: 0, totalCols: 0 };
  }

  const range = XLSX.utils.decode_range(ref);
  const startRow = range.s.r;
  const startCol = range.s.c;
  const totalRows = Math.max(0, range.e.r - startRow + 1);
  const totalCols = Math.max(0, range.e.c - startCol + 1);

  const rowCount = Math.min(totalRows, MODAL_SHEET_MAX_ROWS);
  const colCount = Math.min(totalCols, MODAL_SHEET_MAX_COLS);
  const endRow = startRow + rowCount - 1;
  const endCol = startCol + colCount - 1;

  // Build merge maps (preserve Excel merged headers & cell spans faithfully)
  const mergeStarts = new Map<string, { rowSpan: number; colSpan: number }>();
  const mergeCovered = new Set<string>();
  const merges = sheet['!merges'] || [];

  for (const m of merges) {
    if (m.s.r > endRow || m.s.c > endCol || m.e.r < startRow || m.e.c < startCol) continue;
    const r0 = Math.max(m.s.r, startRow);
    const c0 = Math.max(m.s.c, startCol);
    const r1 = Math.min(m.e.r, endRow);
    const c1 = Math.min(m.e.c, endCol);
    mergeStarts.set(`${r0}:${c0}`, {
      rowSpan: r1 - r0 + 1,
      colSpan: c1 - c0 + 1,
    });
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        if (r === r0 && c === c0) continue;
        mergeCovered.add(`${r}:${c}`);
      }
    }
  }

  // Compute Excel column widths from !cols metadata + content fallback
  const sheetCols = sheet['!cols'] || [];
  const colWidths: number[] = [];
  const colLabels: string[] = [];
  for (let c = 0; c < colCount; c += 1) {
    const absCol = startCol + c;
    colLabels.push(columnIndexToLetter(absCol));
    const meta = sheetCols[absCol];
    let px = 88;
    if (meta && !meta.hidden) {
      if (typeof meta.wpx === 'number' && meta.wpx > 0) {
        px = meta.wpx;
      } else if (typeof meta.wch === 'number' && meta.wch > 0) {
        px = Math.round(meta.wch * 7.6 + 14);
      } else if (typeof meta.width === 'number' && meta.width > 0) {
        px = Math.round(meta.width * 7.6 + 14);
      }
    }
    colWidths.push(Math.min(Math.max(px, 46), 280));
  }

  const rows: SheetGridRow[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const absRow = startRow + r;
    const cells: Array<SheetCellData | null> = [];
    for (let c = 0; c < colCount; c += 1) {
      const absCol = startCol + c;
      const key = `${absRow}:${absCol}`;
      if (mergeCovered.has(key)) {
        cells.push(null);
        continue;
      }

      const merge = mergeStarts.get(key);
      const colSpan = merge ? merge.colSpan : 1;
      const rowSpan = merge ? merge.rowSpan : 1;

      const addr = XLSX.utils.encode_cell({ r: absRow, c: absCol });
      const cell = sheet[addr] as import('xlsx').CellObject | undefined;
      const text = cell ? XLSX.utils.format_cell(cell).trim() : '';

      // If !cols lacked explicit width, expand column gently so short unmerged labels don't clip
      if (colSpan === 1 && !sheetCols[absCol] && text.length > 0) {
        const firstLineLen = text.split(/\r?\n/)[0]?.length || 0;
        const needed = Math.min(Math.max(firstLineLen * 7.5 + 18, 56), 240);
        if (needed > colWidths[c]) colWidths[c] = Math.round(needed);
      }

      cells.push({
        text,
        colSpan,
        rowSpan,
        isNumeric: Boolean(cell && cell.t === 'n'),
        isMultiline: text.includes('\n'),
        isTitleSpan: colSpan >= 3 && r <= 6 && text.length > 0,
      });
    }
    rows.push({ rowNumber: absRow + 1, cells });
  }

  return {
    name,
    colWidths,
    colLabels,
    rows,
    totalRows,
    totalCols,
  };
}

async function fetchAndParsePreview(resource: Resource, kind: PreviewKind): Promise<PreviewData> {
  const res = await fetch(getFileDownloadUrl(resource.id));
  if (!res.ok) {
    throw new Error(`Could not load file (${res.status}).`);
  }
  const buffer = await res.arrayBuffer();

  if (kind === 'pdf') {
    const bytes = new Uint8Array(buffer);
    const { canvas, pageCount } = await renderPdfPageToCanvas(bytes, 1, 480);
    const thumbnailDataUrl = canvas.toDataURL('image/png');
    return { kind: 'pdf', pageCount, thumbnailDataUrl, bytes };
  }

  if (kind === 'docx') {
    return { kind: 'docx', bytes: new Uint8Array(buffer) };
  }

  const XLSX = await loadXlsx();
  const workbook = XLSX.read(buffer, { type: 'array', cellStyles: true });
  const sheets = workbook.SheetNames.map((name) => extractSheetGrid(XLSX, workbook.Sheets[name], name));
  return { kind, sheets };
}

export function loadPreviewData(resource: Resource, kind: PreviewKind): Promise<PreviewData> {
  const cacheKey = `${resource.id}:${resource.updatedAt}`;
  const existing = previewCache.get(cacheKey);
  if (existing) return existing;

  const promise = fetchAndParsePreview(resource, kind).catch((err) => {
    previewCache.delete(cacheKey);
    throw err;
  });
  previewCache.set(cacheKey, promise);
  return promise;
}

function buildSpreadsheetElement(
  sheet: SheetGridData,
  maxRows: number,
  maxCols: number,
  forCardThumbnail: boolean
): { wrapper: HTMLDivElement; naturalWidth: number } {
  const visibleCols = Math.min(sheet.colLabels.length, maxCols);
  const visibleRows = sheet.rows.slice(0, maxRows);

  const wrapper = document.createElement('div');
  wrapper.className = forCardThumbnail ? 'excel-sheet-surface is-card' : 'excel-sheet-surface';

  if (visibleCols === 0 || visibleRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'preview-state-text';
    empty.textContent = '(Empty sheet)';
    wrapper.append(empty);
    return { wrapper, naturalWidth: MIN_VIRTUAL_SHEET_WIDTH };
  }

  const rowHeaderWidth = 34;
  let colSum = 0;
  const colWidths: number[] = [];
  for (let c = 0; c < visibleCols; c += 1) {
    const w = sheet.colWidths[c] || 88;
    colWidths.push(w);
    colSum += w;
  }

  let naturalWidth = rowHeaderWidth + colSum;
  if (forCardThumbnail) {
    naturalWidth = Math.min(Math.max(naturalWidth, MIN_VIRTUAL_SHEET_WIDTH), MAX_CARD_SHEET_WIDTH);
  }

  const table = document.createElement('table');
  table.className = 'excel-grid-table';
  table.style.width = `${Math.max(rowHeaderWidth + colSum, forCardThumbnail ? naturalWidth : 0)}px`;

  const colgroup = document.createElement('colgroup');
  const rowNumCol = document.createElement('col');
  rowNumCol.style.width = `${rowHeaderWidth}px`;
  colgroup.append(rowNumCol);

  for (let c = 0; c < visibleCols; c += 1) {
    const colEl = document.createElement('col');
    colEl.style.width = `${colWidths[c]}px`;
    colgroup.append(colEl);
  }
  table.append(colgroup);

  // Excel-style column letter header row (A, B, C...)
  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  const cornerTh = document.createElement('th');
  cornerTh.className = 'excel-corner-cell';
  cornerTh.scope = 'col';
  headTr.append(cornerTh);

  for (let c = 0; c < visibleCols; c += 1) {
    const th = document.createElement('th');
    th.className = 'excel-col-header';
    th.scope = 'col';
    th.textContent = sheet.colLabels[c];
    headTr.append(th);
  }
  thead.append(headTr);
  table.append(thead);

  // Track cells covered by clamped merges when visibleRows/visibleCols < full grid
  const coveredInView = new Set<string>();
  const tbody = document.createElement('tbody');

  for (let r = 0; r < visibleRows.length; r += 1) {
    const row = visibleRows[r];
    const tr = document.createElement('tr');

    const rowTh = document.createElement('th');
    rowTh.className = 'excel-row-header';
    rowTh.scope = 'row';
    rowTh.textContent = String(row.rowNumber);
    tr.append(rowTh);

    for (let c = 0; c < visibleCols; c += 1) {
      if (coveredInView.has(`${r}:${c}`)) continue;
      const cell = row.cells[c];
      if (cell === null) continue;

      const td = document.createElement('td');
      const clampedColSpan = Math.min(cell.colSpan, visibleCols - c);
      const clampedRowSpan = Math.min(cell.rowSpan, visibleRows.length - r);

      if (clampedColSpan > 1) td.colSpan = clampedColSpan;
      if (clampedRowSpan > 1) td.rowSpan = clampedRowSpan;

      if (clampedColSpan > 1 || clampedRowSpan > 1) {
        for (let rr = r; rr < r + clampedRowSpan; rr += 1) {
          for (let cc = c; cc < c + clampedColSpan; cc += 1) {
            if (rr === r && cc === c) continue;
            coveredInView.add(`${rr}:${cc}`);
          }
        }
      }

      if (cell.isNumeric) td.classList.add('is-num');
      if (cell.isTitleSpan) td.classList.add('is-title-span');
      if (cell.isMultiline) td.classList.add('is-multiline');

      td.textContent = cell.text;
      tr.append(td);
    }

    tbody.append(tr);
  }

  table.append(tbody);
  wrapper.append(table);

  return { wrapper, naturalWidth };
}

function attachResponsiveScale(
  stage: HTMLElement,
  scaledEl: HTMLElement,
  getNaturalWidth: () => number,
  maxScale = 1
): void {
  const applyScale = () => {
    const stageWidth = stage.clientWidth;
    const naturalWidth = Math.max(getNaturalWidth(), 1);
    if (stageWidth <= 0) return;
    const scale = Math.min(stageWidth / naturalWidth, maxScale);
    scaledEl.style.transform = `scale(${scale})`;
  };

  applyScale();
  requestAnimationFrame(applyScale);

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(applyScale);
    ro.observe(stage);
  }
}

async function renderDocxIntoScaledStage(
  stage: HTMLElement,
  bytes: Uint8Array,
  firstPageOnly: boolean
): Promise<void> {
  const docxPreview = await loadDocxPreview();
  const scopeClass = `docx-scope-${++docxScopeCounter}`;

  const styleHost = document.createElement('div');
  const bodyHost = document.createElement('div');
  bodyHost.className = firstPageOnly ? 'preview-scaled-page docx-first-page-only' : 'preview-modal-docx-host';

  // Render full Word page geometry (A4/Letter/Landscape) faithfully
  await docxPreview.renderAsync(bytes.slice().buffer, bodyHost, styleHost, {
    className: scopeClass,
    inWrapper: !firstPageOnly,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    useBase64URL: true,
  });

  if (firstPageOnly) {
    // Keep only the first rendered Word page for a fast, crisp front-page screenshot
    const sections = Array.from(bodyHost.querySelectorAll<HTMLElement>(`section.${scopeClass}`));
    for (let i = 1; i < sections.length; i += 1) {
      sections[i].remove();
    }

    stage.replaceChildren(styleHost, bodyHost);

    const measurePageWidth = () => {
      const firstSection = bodyHost.querySelector<HTMLElement>(`section.${scopeClass}`);
      if (firstSection && firstSection.offsetWidth > 200) {
        return firstSection.offsetWidth;
      }
      return Math.max(bodyHost.scrollWidth, 816);
    };

    attachResponsiveScale(stage, bodyHost, measurePageWidth, 1);
  } else {
    const scaleWrap = document.createElement('div');
    scaleWrap.className = 'preview-modal-docx-scale-wrap';
    scaleWrap.append(styleHost, bodyHost);
    stage.replaceChildren(scaleWrap);

    const syncModalScale = () => {
      const available = Math.max(stage.clientWidth - 24, 240);
      const firstSection = bodyHost.querySelector<HTMLElement>(`section.${scopeClass}`);
      const naturalW = firstSection && firstSection.offsetWidth > 200 ? firstSection.offsetWidth + 32 : 848;
      if (available < naturalW) {
        const scale = available / naturalW;
        bodyHost.style.transformOrigin = 'top left';
        bodyHost.style.transform = `scale(${scale})`;
        bodyHost.style.width = `${naturalW}px`;
        scaleWrap.style.height = `${Math.ceil(bodyHost.scrollHeight * scale)}px`;
      } else {
        bodyHost.style.transform = '';
        bodyHost.style.width = '';
        scaleWrap.style.height = '';
      }
    };

    syncModalScale();
    requestAnimationFrame(syncModalScale);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncModalScale);
      ro.observe(stage);
    }
  }
}

async function renderCardPreviewContent(
  stage: HTMLElement,
  pill: HTMLElement,
  data: PreviewData
): Promise<void> {
  stage.replaceChildren();
  stage.classList.remove('is-loading', 'is-error');

  if (data.kind === 'pdf') {
    const img = document.createElement('img');
    img.className = 'preview-pdf-thumb';
    img.src = data.thumbnailDataUrl;
    img.alt = '';
    img.decoding = 'async';
    stage.append(img);
    pill.textContent = `PDF · ${data.pageCount} ${data.pageCount === 1 ? 'page' : 'pages'}`;
    return;
  }

  if (data.kind === 'docx') {
    await renderDocxIntoScaledStage(stage, data.bytes, true);
    pill.textContent = 'DOCX · Page 1';
    return;
  }

  const firstSheet = data.sheets[0];
  if (firstSheet) {
    const { wrapper, naturalWidth } = buildSpreadsheetElement(
      firstSheet,
      CARD_SHEET_MAX_ROWS,
      CARD_SHEET_MAX_COLS,
      true
    );
    const scaledSheet = document.createElement('div');
    scaledSheet.className = 'preview-scaled-page';
    scaledSheet.style.width = `${naturalWidth}px`;
    scaledSheet.append(wrapper);
    stage.append(scaledSheet);

    attachResponsiveScale(stage, scaledSheet, () => naturalWidth, 1);
  } else {
    const empty = document.createElement('p');
    empty.className = 'preview-state-text';
    empty.textContent = 'Empty workbook';
    stage.append(empty);
  }

  const label = data.kind.toUpperCase();
  const extraSheets = data.sheets.length > 1 ? ` (+${data.sheets.length - 1})` : '';
  pill.textContent = firstSheet ? `${label} · ${firstSheet.name}${extraSheets}` : label;
}

let lazyObserver: IntersectionObserver | null = null;
const pendingTriggers = new WeakMap<Element, () => void>();

function getLazyObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!lazyObserver) {
    lazyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const run = pendingTriggers.get(entry.target);
          if (run) {
            pendingTriggers.delete(entry.target);
            lazyObserver?.unobserve(entry.target);
            run();
          }
        }
      },
      { rootMargin: '220px 0px' }
    );
  }
  return lazyObserver;
}

export function createCardPreviewElement(
  resource: Resource,
  kind: PreviewKind,
  onExpand: (resource: Resource, kind: PreviewKind) => void
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'card-preview';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-preview-trigger';
  btn.setAttribute('aria-label', `Open full preview of ${resource.title}`);

  const stage = document.createElement('div');
  stage.className = 'card-preview-stage is-loading';

  const pill = document.createElement('span');
  pill.className = 'preview-type-pill';
  pill.textContent = kind.toUpperCase();

  const expandHint = document.createElement('span');
  expandHint.className = 'preview-expand-chip';
  expandHint.setAttribute('aria-hidden', 'true');
  expandHint.textContent = 'Full preview ⤢';

  btn.append(stage, pill, expandHint);
  wrapper.append(btn);

  let loaded = false;
  const startLoad = () => {
    if (loaded) return;
    loaded = true;
    stage.classList.add('is-loading');
    stage.classList.remove('is-error');
    const loadingText = document.createElement('span');
    loadingText.className = 'preview-state-text';
    loadingText.textContent = `Loading ${kind.toUpperCase()} preview…`;
    stage.replaceChildren(loadingText);

    void loadPreviewData(resource, kind)
      .then((data) => renderCardPreviewContent(stage, pill, data))
      .catch(() => {
        stage.classList.remove('is-loading');
        stage.classList.add('is-error');
        const msg = document.createElement('span');
        msg.className = 'preview-state-text';
        msg.textContent = 'Preview unavailable — click Download below';
        stage.replaceChildren(msg);
      });
  };

  btn.addEventListener('click', () => {
    onExpand(resource, kind);
  });

  const isLargeFile = Boolean(resource.fileSize && resource.fileSize > AUTO_PREVIEW_MAX_BYTES);
  if (isLargeFile) {
    stage.classList.remove('is-loading');
    const sizeText = formatFileSize(resource.fileSize);
    const prompt = document.createElement('span');
    prompt.className = 'preview-state-text';
    prompt.textContent = `Large ${kind.toUpperCase()} (${sizeText}) — click to preview`;
    stage.replaceChildren(prompt);
  } else {
    const observer = getLazyObserver();
    if (observer) {
      pendingTriggers.set(wrapper, startLoad);
      observer.observe(wrapper);
    } else {
      startLoad();
    }
  }

  return wrapper;
}

export async function renderModalPreview(
  bodyEl: HTMLElement,
  toolbarEl: HTMLElement,
  resource: Resource,
  kind: PreviewKind
): Promise<void> {
  toolbarEl.replaceChildren();
  toolbarEl.hidden = true;

  const loading = document.createElement('p');
  loading.className = 'preview-modal-state';
  loading.textContent = `Loading ${kind.toUpperCase()} preview…`;
  bodyEl.replaceChildren(loading);

  const data = await loadPreviewData(resource, kind);

  if (data.kind === 'pdf') {
    let currentPage = 1;
    const canvasHost = document.createElement('div');
    canvasHost.className = 'preview-modal-pdf-host';

    const renderPage = async (pageNum: number) => {
      currentPage = Math.min(Math.max(1, pageNum), data.pageCount);
      prevBtn.disabled = currentPage <= 1;
      nextBtn.disabled = currentPage >= data.pageCount;
      pageLabel.textContent = `Page ${currentPage} of ${data.pageCount}`;

      const width = Math.max(Math.min(bodyEl.clientWidth - 32, 860), 320);
      const { canvas } = await renderPdfPageToCanvas(data.bytes, currentPage, width);
      canvas.className = 'preview-modal-canvas';
      canvasHost.replaceChildren(canvas);
    };

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'btn btn-secondary btn-sm';
    prevBtn.textContent = '← Previous';
    prevBtn.addEventListener('click', () => void renderPage(currentPage - 1));

    const pageLabel = document.createElement('span');
    pageLabel.className = 'preview-page-indicator';

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn btn-secondary btn-sm';
    nextBtn.textContent = 'Next →';
    nextBtn.addEventListener('click', () => void renderPage(currentPage + 1));

    if (data.pageCount > 1) {
      toolbarEl.replaceChildren(prevBtn, pageLabel, nextBtn);
      toolbarEl.hidden = false;
    } else {
      pageLabel.textContent = 'Page 1 of 1';
      toolbarEl.replaceChildren(pageLabel);
      toolbarEl.hidden = false;
    }

    bodyEl.replaceChildren(canvasHost);
    await renderPage(1);
    return;
  }

  if (data.kind === 'docx') {
    await renderDocxIntoScaledStage(bodyEl, data.bytes, false);
    return;
  }

  // XLSX / XLSM with true merged cells + sheet tabs
  if (data.sheets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'preview-modal-state';
    empty.textContent = 'This workbook contains no visible sheets.';
    bodyEl.replaceChildren(empty);
    return;
  }

  let activeIndex = 0;
  const sheetHost = document.createElement('div');
  sheetHost.className = 'preview-modal-sheet-host';

  const renderActiveSheet = () => {
    const sheet = data.sheets[activeIndex];
    const tableWrap = document.createElement('div');
    tableWrap.className = 'preview-modal-table-wrap';
    const { wrapper } = buildSpreadsheetElement(sheet, MODAL_SHEET_MAX_ROWS, MODAL_SHEET_MAX_COLS, false);
    tableWrap.append(wrapper);

    const nodes: HTMLElement[] = [tableWrap];
    if (sheet.totalRows > MODAL_SHEET_MAX_ROWS || sheet.totalCols > MODAL_SHEET_MAX_COLS) {
      const note = document.createElement('p');
      note.className = 'preview-modal-note';
      note.textContent = `Showing first ${Math.min(sheet.totalRows, MODAL_SHEET_MAX_ROWS)} of ${sheet.totalRows} rows and ${Math.min(sheet.totalCols, MODAL_SHEET_MAX_COLS)} of ${sheet.totalCols} columns. Download the file for the full spreadsheet.`;
      nodes.push(note);
    }
    sheetHost.replaceChildren(...nodes);

    toolbarEl.querySelectorAll<HTMLButtonElement>('.subcat-btn').forEach((b, idx) => {
      b.setAttribute('aria-pressed', idx === activeIndex ? 'true' : 'false');
    });
  };

  if (data.sheets.length > 1) {
    const buttons = data.sheets.map((sheet, idx) => {
      const sheetBtn = document.createElement('button');
      sheetBtn.type = 'button';
      sheetBtn.className = 'subcat-btn';
      sheetBtn.textContent = sheet.name;
      sheetBtn.setAttribute('aria-pressed', idx === 0 ? 'true' : 'false');
      sheetBtn.addEventListener('click', () => {
        activeIndex = idx;
        renderActiveSheet();
      });
      return sheetBtn;
    });
    toolbarEl.replaceChildren(...buttons);
    toolbarEl.hidden = false;
  }

  bodyEl.replaceChildren(sheetHost);
  renderActiveSheet();
}
