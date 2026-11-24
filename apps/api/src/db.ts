import type { Category, LinkPreview, PortalPayload, Resource, SchoolSettings, Subcategory } from '@school-portal/shared';
import { hashPassword } from './auth';
import type { Env } from './types';

export interface SettingsRow {
  school_name: string;
  tagline: string;
  announcement: string;
  logo_key: string | null;
  logo_mime_type: string | null;
  updated_at: string;
}

export function mapSettingsRow(row: SettingsRow | null | undefined): SchoolSettings {
  if (!row) {
    return {
      schoolName: 'School Portal',
      tagline: 'Teacher Resource & Submission Hub',
      announcement: '',
      logoUrl: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    schoolName: row.school_name,
    tagline: row.tagline,
    announcement: row.announcement,
    logoUrl: row.logo_key ? `/api/logo?v=${encodeURIComponent(row.updated_at)}` : null,
    updatedAt: row.updated_at,
  };
}

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  sort_order: number;
}

interface SubcategoryRow {
  id: string;
  category_id: string;
  slug: string;
  name: string;
  description: string;
  sort_order: number;
}

export interface ResourceRow {
  id: string;
  category_id: string;
  subcategory_id: string | null;
  title: string;
  description: string;
  type: 'link' | 'file';
  url: string | null;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  is_pinned: number;
  sort_order: number;
  updated_at: string;
  preview_title?: string | null;
  preview_description?: string | null;
  preview_image?: string | null;
  preview_site_name?: string | null;
  preview_favicon?: string | null;
  preview_fetched_at?: string | null;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin';
}

export function mapResourceRow(row: ResourceRow): Resource {
  let linkPreview: LinkPreview | null = null;
  if (row.type === 'link' && row.preview_fetched_at) {
    linkPreview = {
      title: row.preview_title ?? null,
      description: row.preview_description ?? null,
      image: row.preview_image ?? null,
      siteName: row.preview_site_name ?? null,
      favicon: row.preview_favicon ?? null,
      fetchedAt: row.preview_fetched_at ?? null,
    };
  }

  return {
    id: row.id,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id ?? null,
    title: row.title,
    description: row.description,
    type: row.type,
    url: row.url,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    isPinned: Boolean(row.is_pinned),
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
    linkPreview,
  };
}

export async function ensureDefaultAdmin(env: Env): Promise<void> {
  const existing = await env.DB.prepare('SELECT id FROM users LIMIT 1').first<{ id: string }>();
  if (existing) return;

  const username = (env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = env.ADMIN_DEFAULT_PASSWORD || 'school1234';
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    'INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'
  )
    .bind('admin-1', username, passwordHash, 'admin')
    .run();
}

export async function getPortalPayload(db: D1Database): Promise<PortalPayload> {
  const [settingsRow, categoriesRes, subcategoriesRes, resourcesRes] = await Promise.all([
    db
      .prepare('SELECT school_name, tagline, announcement, logo_key, logo_mime_type, updated_at FROM settings WHERE id = 1')
      .first<SettingsRow>(),
    db
      .prepare('SELECT id, slug, name, description, sort_order FROM categories ORDER BY sort_order ASC, name ASC')
      .all<CategoryRow>(),
    db
      .prepare('SELECT id, category_id, slug, name, description, sort_order FROM subcategories ORDER BY sort_order ASC, name ASC')
      .all<SubcategoryRow>(),
    db
      .prepare(
        `SELECT id, category_id, subcategory_id, title, description, type, url, file_key, file_name, file_size, mime_type, is_pinned, sort_order, updated_at,
                preview_title, preview_description, preview_image, preview_site_name, preview_favicon, preview_fetched_at
         FROM resources
         ORDER BY is_pinned DESC, sort_order ASC, updated_at DESC`
      )
      .all<ResourceRow>(),
  ]);

  const settings: SchoolSettings = mapSettingsRow(settingsRow);

  const categories: Category[] = (categoriesRes.results || []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
  }));

  const subcategories: Subcategory[] = (subcategoriesRes.results || []).map((row) => ({
    id: row.id,
    categoryId: row.category_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
  }));

  const resources: Resource[] = (resourcesRes.results || []).map(mapResourceRow);

  return { settings, categories, subcategories, resources };
}
