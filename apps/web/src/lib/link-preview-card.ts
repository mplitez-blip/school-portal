import type { LinkPreview, Resource } from '@school-portal/shared';
import { fetchLinkPreview } from './api';

const linkPreviewCache = new Map<string, Promise<LinkPreview>>();
let linkLazyObserver: IntersectionObserver | null = null;
const pendingLinkTriggers = new WeakMap<Element, () => void>();

function getLinkLazyObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!linkLazyObserver) {
    linkLazyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const run = pendingLinkTriggers.get(entry.target);
          if (run) {
            pendingLinkTriggers.delete(entry.target);
            linkLazyObserver?.unobserve(entry.target);
            run();
          }
        }
      },
      { rootMargin: '220px 0px' }
    );
  }
  return linkLazyObserver;
}

function getLinkAccentColor(urlStr: string, siteName: string | null): string {
  const lowerUrl = urlStr.toLowerCase();
  const lowerSite = (siteName || '').toLowerCase();
  if (lowerSite.includes('google forms') || lowerUrl.includes('forms.gle') || lowerUrl.includes('/forms/')) {
    return '#673ab7';
  }
  if (lowerSite.includes('google sheets') || lowerUrl.includes('/spreadsheets/')) {
    return '#0f9d58';
  }
  if (lowerSite.includes('google docs') || lowerUrl.includes('/document/')) {
    return '#1a73e8';
  }
  if (lowerSite.includes('google slides') || lowerUrl.includes('/presentation/')) {
    return '#d97706';
  }
  if (lowerSite.includes('youtube') || lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    return '#dc2626';
  }
  return '#0f4c5c';
}

function formatDisplayUrl(rawUrl: string): { host: string; displayPath: string } {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    const combined = `${host}${path}`;
    return {
      host,
      displayPath: combined.length > 42 ? `${combined.slice(0, 41)}…` : combined,
    };
  } catch {
    return { host: 'Website', displayPath: rawUrl };
  }
}

function buildMiniBrowserFallback(
  resource: Resource,
  preview: LinkPreview | null,
  urlStr: string
): HTMLElement {
  const { host, displayPath } = formatDisplayUrl(urlStr);
  const accent = getLinkAccentColor(urlStr, preview?.siteName ?? null);

  const shell = document.createElement('div');
  shell.className = 'link-browser-preview';
  shell.style.setProperty('--link-accent', accent);

  const chrome = document.createElement('div');
  chrome.className = 'link-browser-chrome';

  const dots = document.createElement('span');
  dots.className = 'link-browser-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));

  const address = document.createElement('span');
  address.className = 'link-browser-address';

  const faviconUrl =
    preview?.favicon ||
    (host !== 'Website' ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : null);
  if (faviconUrl) {
    const icon = document.createElement('img');
    icon.className = 'link-browser-favicon';
    icon.src = faviconUrl;
    icon.alt = '';
    icon.width = 14;
    icon.height = 14;
    icon.loading = 'lazy';
    icon.decoding = 'async';
    icon.referrerPolicy = 'no-referrer';
    icon.addEventListener('error', () => icon.remove());
    address.append(icon);
  }

  const addrText = document.createElement('span');
  addrText.className = 'link-browser-url';
  addrText.textContent = displayPath;
  address.append(addrText);

  chrome.append(dots, address);

  const body = document.createElement('div');
  body.className = 'link-browser-body';

  const titleEl = document.createElement('p');
  titleEl.className = 'link-browser-title';
  titleEl.textContent = preview?.title || resource.title;

  const descEl = document.createElement('p');
  descEl.className = 'link-browser-desc';
  descEl.textContent = preview?.description || resource.description || `Opens ${host} in a new tab.`;

  body.append(titleEl, descEl);
  shell.append(chrome, body);
  return shell;
}

function renderLinkPreviewStage(
  stage: HTMLElement,
  pill: HTMLElement,
  resource: Resource,
  preview: LinkPreview | null,
  urlStr: string
): void {
  const { host } = formatDisplayUrl(urlStr);
  pill.textContent = preview?.siteName || host;
  stage.classList.remove('is-loading', 'is-error');

  if (preview?.image) {
    const img = document.createElement('img');
    img.className = 'preview-link-image';
    img.src = preview.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      stage.replaceChildren(buildMiniBrowserFallback(resource, preview, urlStr));
    });
    stage.replaceChildren(img);
    return;
  }

  stage.replaceChildren(buildMiniBrowserFallback(resource, preview, urlStr));
}

function getCachedOrFetchLinkPreview(resource: Resource): Promise<LinkPreview> {
  const cacheKey = `${resource.id}:${resource.updatedAt}:${resource.url || ''}`;
  const existing = linkPreviewCache.get(cacheKey);
  if (existing) return existing;

  const promise = fetchLinkPreview(resource.id).catch((err) => {
    linkPreviewCache.delete(cacheKey);
    throw err;
  });
  linkPreviewCache.set(cacheKey, promise);
  return promise;
}

export function createLinkPreviewElement(resource: Resource): HTMLElement | null {
  if (resource.type !== 'link' || !resource.url) return null;
  const urlStr = resource.url;

  const wrapper = document.createElement('div');
  wrapper.className = 'card-preview card-preview-link';

  const anchor = document.createElement('a');
  anchor.className = 'card-preview-trigger';
  anchor.href = urlStr;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.setAttribute('aria-label', `Open website preview for ${resource.title}`);

  const stage = document.createElement('div');
  stage.className = 'card-preview-stage card-preview-link-stage';

  const pill = document.createElement('span');
  pill.className = 'preview-type-pill';

  const openChip = document.createElement('span');
  openChip.className = 'preview-expand-chip';
  openChip.setAttribute('aria-hidden', 'true');
  openChip.textContent = 'Open site ↗';

  anchor.append(stage, pill, openChip);
  wrapper.append(anchor);

  // Immediately render cached preview (or clean browser card while uncached links backfill)
  renderLinkPreviewStage(stage, pill, resource, resource.linkPreview ?? null, urlStr);

  if (!resource.linkPreview) {
    let requested = false;
    const backfill = () => {
      if (requested) return;
      requested = true;
      void getCachedOrFetchLinkPreview(resource)
        .then((preview) => {
          resource.linkPreview = preview;
          renderLinkPreviewStage(stage, pill, resource, preview, urlStr);
        })
        .catch(() => {
          // Keep clean fallback preview card already rendered
        });
    };

    const observer = getLinkLazyObserver();
    if (observer) {
      pendingLinkTriggers.set(wrapper, backfill);
      observer.observe(wrapper);
    } else {
      backfill();
    }
  }

  return wrapper;
}
