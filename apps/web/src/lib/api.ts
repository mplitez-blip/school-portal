import type { LinkPreview, PortalPayload, Resource, SchoolSettings } from '@school-portal/shared';

export const API_URL = (import.meta.env.PUBLIC_API_URL || 'http://localhost:8787').replace(/\/+$/, '');

const TOKEN_STORAGE_KEY = 'school_portal_admin_token';

export function getSavedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage quota errors
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getFileDownloadUrl(resourceId: string): string {
  return `${API_URL}/api/files/${encodeURIComponent(resourceId)}`;
}

export function resolveApiAssetUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  return `${API_URL}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // Ignore non-JSON body
  }
  return `Request failed (${res.status}).`;
}

export async function fetchPortal(): Promise<PortalPayload> {
  const res = await fetch(`${API_URL}/api/portal`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as PortalPayload;
}

export async function fetchLinkPreview(resourceId: string): Promise<LinkPreview> {
  const res = await fetch(`${API_URL}/api/link-preview/${encodeURIComponent(resourceId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { preview: LinkPreview };
  return data.preview;
}

export async function adminLogin(
  username: string,
  password: string
): Promise<{ token: string; user: { id: string; username: string; role: string } }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { token: string; user: { id: string; username: string; role: string } };
}

export async function verifyAdminSession(
  token: string
): Promise<{ user: { id: string; username: string; role: string } } | null> {
  const res = await fetch(`${API_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as { user: { id: string; username: string; role: string } };
}

export async function updateSchoolSettings(
  token: string,
  input: { schoolName: string; tagline: string; announcement: string }
): Promise<{ settings: SchoolSettings }> {
  const res = await fetch(`${API_URL}/api/admin/settings`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { settings: SchoolSettings };
}

export async function uploadSchoolLogo(
  token: string,
  file: File
): Promise<{ settings: SchoolSettings }> {
  const formData = new FormData();
  formData.append('logo', file);
  const res = await fetch(`${API_URL}/api/admin/settings/logo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { settings: SchoolSettings };
}

export async function deleteSchoolLogo(token: string): Promise<{ settings: SchoolSettings }> {
  const res = await fetch(`${API_URL}/api/admin/settings/logo`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { settings: SchoolSettings };
}

export async function changeAdminPassword(
  token: string,
  input: { currentPassword: string; newPassword: string }
): Promise<void> {
  const res = await fetch(`${API_URL}/api/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function createLinkResource(
  token: string,
  input: {
    categoryId: string;
    subcategoryId?: string | null;
    title: string;
    description: string;
    url: string;
    isPinned: boolean;
  }
): Promise<{ resource: Resource }> {
  const res = await fetch(`${API_URL}/api/admin/resources`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { resource: Resource };
}

export async function createFileResource(
  token: string,
  formData: FormData
): Promise<{ resource: Resource }> {
  const res = await fetch(`${API_URL}/api/admin/resources`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { resource: Resource };
}

export async function updateResource(
  token: string,
  id: string,
  input: {
    categoryId?: string;
    subcategoryId?: string | null;
    title?: string;
    description?: string;
    url?: string;
    isPinned?: boolean;
  }
): Promise<{ resource: Resource }> {
  const res = await fetch(`${API_URL}/api/admin/resources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { resource: Resource };
}

export async function deleteResource(token: string, id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/admin/resources/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
