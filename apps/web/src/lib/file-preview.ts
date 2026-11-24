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
  html: string;
}

export interface SheetTableData {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
}

export interface SpreadsheetPreviewData {
  kind: 'xlsx' | 'xlsm';
  sheets: SheetTableData[];
}

export type PreviewData = PdfPreviewData | DocxPreviewData | SpreadsheetPreviewData;

const AUTO_PREVIEW_MAX_BYTES = 10 * 1024 * 1024; // Auto-load previews up to 10 MB
const CARD_SHEET_ROWS = 8;
const CARD_SHEET_COLS = 5;
const MODAL_SHEET_ROWS = 80;
const MODAL_SHEET_COLS = 16;

const DOCX_ALLOWED_ELEMENTS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'blockquote',
];
const DOCX_ALLOWED_ATTRIBUTES = ['colspan', 'rowspan'];

const previewCache = new Map<string, Promise<PreviewData>>();

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
let mammothPromise: Promise<{ convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }> | null = null;
let xlsxPromise: Promise<typeof import('xlsx')> | null = null;
let domPurifyPromise: Promise<typeof import('dompurify')['default']> | null = null;

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

async function loadMammoth(): Promise<{
  convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
}> {
  if (!mammothPromise) {
    // Load pre-bundled browser UMD build so Vite needs no Node polyfills
    mammothPromise = (import('mammoth/mammoth.browser.min.js' as string) as Promise<unknown>).then((mod) => {
      const m = mod as {
        default?: { convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
        convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
      };
      const winMammoth = (window as unknown as { mammoth?: typeof m }).mammoth;
      const resolved = m.convertToHtml ? m : m.default?.convertToHtml ? m.default : winMammoth;
      if (!resolved?.convertToHtml) {
        throw new Error('DOCX preview engine could not initialize.');
      }
      return { convertToHtml: resolved.convertToHtml.bind(resolved) };
    });
  }
  return mammothPromise;
}

async function loadXlsx(): Promise<typeof import('xlsx')> {
  xlsxPromise ??= import('xlsx');
  return xlsxPromise;
}

async function loadDOMPurify(): Promise<typeof import('dompurify')['default']> {
  domPurifyPromise ??= import('dompurify').then((mod) => mod.default ?? (mod as unknown as typeof import('dompurify')['default']));
  return domPurifyPromise;
}

export async function safeSetDocxHtml(el: HTMLElement, html: string): Promise<void> {
  if ('setHTML' in Element.prototype) {
    (
      el as HTMLElement & {
        setHTML: (
          input: string,
          options?: { sanitizer?: { elements?: string[]; attributes?: string[] } }
        ) => void;
      }
    ).setHTML(html, {
      sanitizer: {
        elements: DOCX_ALLOWED_ELEMENTS,
        attributes: DOCX_ALLOWED_ATTRIBUTES,
      },
    });
  } else {
    const DOMPurify = await loadDOMPurify();
    el.innerHTML = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...DOCX_ALLOWED_ELEMENTS, '#text'],
      ALLOWED_ATTR: DOCX_ALLOWED_ATTRIBUTES,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: false,
    });
  }
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

async function fetchAndParsePreview(resource: Resource, kind: PreviewKind): Promise<PreviewData> {
  const res = await fetch(getFileDownloadUrl(resource.id));
  if (!res.ok) {
    throw new Error(`Could not load file (${res.status}).`);
  }
  const buffer = await res.arrayBuffer();

  if (kind === 'pdf') {
    const bytes = new Uint8Array(buffer);
    const { canvas, pageCount } = await renderPdfPageToCanvas(bytes, 1, 360);
    const thumbnailDataUrl = canvas.toDataURL('image/png');
    return { kind: 'pdf', pageCount, thumbnailDataUrl, bytes };
  }

  if (kind === 'docx') {
    const mammoth = await loadMammoth();
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    return { kind: 'docx', html: result.value || '<p>(Empty document)</p>' };
  }

  // xlsx or xlsm via SheetJS
  const XLSX = await loadXlsx();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheets: SheetTableData[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    });

    const totalRows = rawRows.length;
    let totalCols = 0;
    for (const r of rawRows) {
      if (Array.isArray(r) && r.length > totalCols) totalCols = r.length;
    }

    const colLimit = Math.min(Math.max(totalCols, 1), MODAL_SHEET_COLS);
    const trimmedRows = rawRows.slice(0, MODAL_SHEET_ROWS).map((row) => {
      const arr = Array.isArray(row) ? row : [];
      const cells: string[] = [];
      for (let i = 0; i < colLimit; i += 1) {
        const val = arr[i];
        cells.push(val === null || val === undefined ? '' : String(val).trim());
      }
      return cells;
    });

    return {
      name,
      rows: trimmedRows,
      totalRows,
      totalCols,
    };
  });

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

function buildSheetTableElement(sheet: SheetTableData, maxRows: number, maxCols: number): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'preview-sheet-table';

  const visibleRows = sheet.rows.slice(0, maxRows);
  if (visibleRows.length === 0) {
    const tbody = document.createElement('tbody');
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = '(Empty sheet)';
    tr.append(td);
    tbody.append(tr);
    table.append(tbody);
    return table;
  }

  const colCount = Math.min(
    Math.max(1, ...visibleRows.map((r) => r.length)),
    maxCols
  );

  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  for (let c = 0; c < colCount; c += 1) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = visibleRows[0]?.[c] || `Col ${c + 1}`;
    headTr.append(th);
  }
  thead.append(headTr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (let r = 1; r < visibleRows.length; r += 1) {
    const tr = document.createElement('tr');
    for (let c = 0; c < colCount; c += 1) {
      const td = document.createElement('td');
      td.textContent = visibleRows[r]?.[c] || '';
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
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
    const docSheet = document.createElement('div');
    docSheet.className = 'preview-docx-mini';
    await safeSetDocxHtml(docSheet, data.html);
    stage.append(docSheet);
    pill.textContent = 'DOCX';
    return;
  }

  const firstSheet = data.sheets[0];
  const wrap = document.createElement('div');
  wrap.className = 'preview-xlsx-mini';
  if (firstSheet) {
    wrap.append(buildSheetTableElement(firstSheet, CARD_SHEET_ROWS, CARD_SHEET_COLS));
  } else {
    const empty = document.createElement('p');
    empty.className = 'preview-state-text';
    empty.textContent = 'Empty workbook';
    wrap.append(empty);
  }
  stage.append(wrap);

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
    const paper = document.createElement('article');
    paper.className = 'preview-modal-docx';
    await safeSetDocxHtml(paper, data.html);
    bodyEl.replaceChildren(paper);
    return;
  }

  // XLSX / XLSM with sheet tabs
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
    tableWrap.append(buildSheetTableElement(sheet, MODAL_SHEET_ROWS, MODAL_SHEET_COLS));

    const nodes: HTMLElement[] = [tableWrap];
    if (sheet.totalRows > MODAL_SHEET_ROWS || sheet.totalCols > MODAL_SHEET_COLS) {
      const note = document.createElement('p');
      note.className = 'preview-modal-note';
      note.textContent = `Showing first ${Math.min(sheet.totalRows, MODAL_SHEET_ROWS)} of ${sheet.totalRows} rows and ${Math.min(sheet.totalCols, MODAL_SHEET_COLS)} of ${sheet.totalCols} columns. Download the file for the full spreadsheet.`;
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
