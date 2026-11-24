import type { LinkPreview } from '@school-portal/shared';

const MAX_HTML_BYTES = 128 * 1024; // 128 KB is plenty to inspect <head>
const FETCH_TIMEOUT_MS = 4000;

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  // IPv4 private / loopback / link-local / CGNAT checks
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }

  // IPv6 private / link-local
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
    return true;
  }

  return false;
}

export function isSafePublicHttpUrl(rawUrl: string): URL | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || isPrivateOrLocalHost(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

function resolveSafeUrl(candidate: string | null | undefined, base: string): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) return null;
  try {
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (isPrivateOrLocalHost(resolved.hostname)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tag)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtmlEntities(val);
  }
  return attrs;
}

function detectKnownServiceHints(url: URL): { siteName: string | null; image: string | null } {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // YouTube direct thumbnail
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    let videoId: string | null = null;
    if (host === 'youtu.be') {
      videoId = path.replace(/^\/+/, '').split('/')[0] || null;
    } else if (path === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const m = path.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{6,})/);
      if (m) videoId = m[1];
    }
    return {
      siteName: 'YouTube',
      image: videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : null,
    };
  }

  // Google Forms
  if (host === 'forms.gle' || (host === 'docs.google.com' && path.includes('/forms/'))) {
    return { siteName: 'Google Forms', image: null };
  }

  // Google Docs / Sheets / Slides / Drive
  if (host === 'docs.google.com' || host === 'drive.google.com') {
    const docMatch = path.match(/\/(?:document|spreadsheets|presentation|file)\/d\/([a-zA-Z0-9_-]{10,})/);
    const driveThumbnail = docMatch
      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(docMatch[1])}&sz=w800`
      : null;

    if (path.includes('/spreadsheets/')) return { siteName: 'Google Sheets', image: driveThumbnail };
    if (path.includes('/presentation/')) return { siteName: 'Google Slides', image: driveThumbnail };
    if (path.includes('/document/')) return { siteName: 'Google Docs', image: driveThumbnail };
    return { siteName: 'Google Drive', image: driveThumbnail };
  }

  return { siteName: null, image: null };
}

async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export async function fetchLinkPreviewMetadata(rawUrl: string): Promise<LinkPreview> {
  const now = new Date().toISOString();
  const safeUrl = isSafePublicHttpUrl(rawUrl);
  if (!safeUrl) {
    return {
      title: null,
      description: null,
      image: null,
      siteName: null,
      favicon: null,
      fetchedAt: now,
    };
  }

  const hints = detectKnownServiceHints(safeUrl);
  const fallbackFavicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(safeUrl.hostname)}&sz=64`;
  let title: string | null = null;
  let description: string | null = null;
  let image: string | null = hints.image;
  let siteName: string | null = hints.siteName || safeUrl.hostname.replace(/^www\./, '');
  let favicon: string | null = fallbackFavicon;

  try {
    const res = await fetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'SchoolPortalLinkPreview/1.0 (+https://developers.cloudflare.com/workers/)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      },
    });

    const finalUrl = isSafePublicHttpUrl(res.url || safeUrl.toString());
    if (finalUrl) {
      const finalHints = detectKnownServiceHints(finalUrl);
      if (finalHints.siteName) siteName = finalHints.siteName;
      if (!image && finalHints.image) image = finalHints.image;
      favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(finalUrl.hostname)}&sz=64`;
    }

    const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
    if (res.ok && finalUrl && (contentType.includes('text/html') || contentType.includes('application/xhtml'))) {
      const html = await readLimitedText(res, MAX_HTML_BYTES);
      const baseHref = finalUrl.toString();

      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const htmlTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;

      let ogTitle: string | null = null;
      let ogDesc: string | null = null;
      let metaDesc: string | null = null;
      let ogImage: string | null = null;
      let ogSiteName: string | null = null;
      let iconHref: string | null = null;

      const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
      for (const tag of metaTags) {
        const attrs = parseAttributes(tag);
        const key = (attrs.property || attrs.name || '').toLowerCase();
        const content = attrs.content || '';
        if (!key || !content) continue;

        if ((key === 'og:title' || key === 'twitter:title') && !ogTitle) ogTitle = content;
        if ((key === 'og:description' || key === 'twitter:description') && !ogDesc) ogDesc = content;
        if (key === 'description' && !metaDesc) metaDesc = content;
        if ((key === 'og:image' || key === 'og:image:secure_url' || key === 'twitter:image') && !ogImage) {
          ogImage = resolveSafeUrl(content, baseHref);
        }
        if (key === 'og:site_name' && !ogSiteName) ogSiteName = content;
      }

      const linkTags = html.match(/<link\b[^>]*>/gi) || [];
      for (const tag of linkTags) {
        const attrs = parseAttributes(tag);
        const rel = (attrs.rel || '').toLowerCase();
        if (!attrs.href) continue;
        if (rel === 'apple-touch-icon' || rel.includes('icon')) {
          const resolved = resolveSafeUrl(attrs.href, baseHref);
          if (resolved) {
            iconHref = resolved;
            if (rel === 'apple-touch-icon') break;
          }
        }
      }

      title = (ogTitle || htmlTitle || '').slice(0, 180) || null;
      description = (ogDesc || metaDesc || '').slice(0, 320) || null;
      if (ogImage) image = ogImage;
      if (ogSiteName && !hints.siteName) siteName = ogSiteName.slice(0, 80);
      if (iconHref) favicon = iconHref;
    }
  } catch {
    // Keep graceful domain/service hints even when target blocks bots or times out
  }

  return {
    title,
    description,
    image,
    siteName,
    favicon,
    fetchedAt: now,
  };
}
