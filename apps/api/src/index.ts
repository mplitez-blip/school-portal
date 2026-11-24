import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import {
  ChangePasswordInputSchema,
  CreateLinkResourceInputSchema,
  LoginInputSchema,
  UpdateResourceInputSchema,
  UpdateSettingsInputSchema,
} from '@school-portal/shared';
import { createAdminToken, hashPassword, verifyAdminToken, verifyPassword } from './auth';
import { ensureDefaultAdmin, getPortalPayload, mapResourceRow, type ResourceRow, type UserRow } from './db';
import type { Env, JwtUserPayload } from './types';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

type AppVariables = {
  admin: JwtUserPayload;
};

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const configured = (c.env.CORS_ORIGIN || '*').trim();
      if (configured === '*') return origin || '*';
      const allowed = configured.split(',').map((s: string) => s.trim());
      return origin && allowed.includes(origin) ? origin : allowed[0];
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120) || 'download';
}

// Health check
app.get('/api/health', (c) => {
  return c.json({ ok: true, service: 'school-portal-api' });
});

// Public endpoint for Teacher Portal & future Android app (no login required)
app.get('/api/portal', async (c) => {
  const payload = await getPortalPayload(c.env.DB);
  return c.json(payload);
});

// Public file download streamed directly from Cloudflare R2
app.get('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, file_key, file_name, mime_type FROM resources WHERE id = ? AND type = ?'
  )
    .bind(id, 'file')
    .first<Pick<ResourceRow, 'id' | 'file_key' | 'file_name' | 'mime_type'>>();

  if (!row || !row.file_key) {
    return c.json({ error: 'File not found.' }, 404);
  }

  const object = await c.env.FILES.get(row.file_key);
  if (!object) {
    return c.json({ error: 'File is missing from storage.' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (row.mime_type) {
    headers.set('Content-Type', row.mime_type);
  } else if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/octet-stream');
  }

  const safeName = sanitizeFileName(row.file_name || 'download');
  const encodedName = encodeURIComponent(safeName);
  headers.set(
    'Content-Disposition',
    `attachment; filename="${safeName.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`
  );

  return new Response(object.body, { status: 200, headers });
});

// Admin authentication
app.post('/api/auth/login', async (c) => {
  await ensureDefaultAdmin(c.env);

  const body = await c.req.json().catch(() => null);
  const parsed = LoginInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid login input.' }, 400);
  }

  const username = parsed.data.username.toLowerCase();
  const user = await c.env.DB.prepare(
    'SELECT id, username, password_hash, role FROM users WHERE LOWER(username) = ?'
  )
    .bind(username)
    .first<UserRow>();

  if (!user) {
    return c.json({ error: 'Incorrect username or password.' }, 401);
  }

  const valid = await verifyPassword(parsed.data.password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Incorrect username or password.' }, 401);
  }

  const token = await createAdminToken(c.env, {
    id: user.id,
    username: user.username,
    role: user.role,
  });

  return c.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  });
});

// Protect all /api/admin/* and /api/auth/me + /api/auth/change-password routes
const requireAdmin = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Admin sign-in required.' }, 401);
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const payload = await verifyAdminToken(c.env, token);
    if (!payload) {
      return c.json({ error: 'Session expired. Please sign in again.' }, 401);
    }
    c.set('admin', payload);
    await next();
  }
);

app.use('/api/admin/*', requireAdmin);
app.use('/api/auth/me', requireAdmin);
app.use('/api/auth/change-password', requireAdmin);

app.get('/api/auth/me', (c) => {
  const admin = c.get('admin');
  return c.json({
    user: {
      id: admin.sub,
      username: admin.username,
      role: admin.role,
    },
  });
});

app.post('/api/auth/change-password', async (c) => {
  const admin = c.get('admin');
  const body = await c.req.json().catch(() => null);
  const parsed = ChangePasswordInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid password input.' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ?')
    .bind(admin.sub)
    .first<Pick<UserRow, 'id' | 'password_hash'>>();

  if (!user) {
    return c.json({ error: 'Account not found.' }, 404);
  }

  const matches = await verifyPassword(parsed.data.currentPassword, user.password_hash);
  if (!matches) {
    return c.json({ error: 'Current password is incorrect.' }, 400);
  }

  const nextHash = await hashPassword(parsed.data.newPassword);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  )
    .bind(nextHash, admin.sub)
    .run();

  return c.json({ ok: true });
});

// Admin: Update school name, tagline, announcement
app.patch('/api/admin/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateSettingsInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid school settings.' }, 400);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO settings (id, school_name, tagline, announcement, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       school_name = excluded.school_name,
       tagline = excluded.tagline,
       announcement = excluded.announcement,
       updated_at = excluded.updated_at`
  )
    .bind(parsed.data.schoolName, parsed.data.tagline, parsed.data.announcement, now)
    .run();

  return c.json({
    settings: {
      schoolName: parsed.data.schoolName,
      tagline: parsed.data.tagline,
      announcement: parsed.data.announcement,
      updatedAt: now,
    },
  });
});

// Admin: Create external link resource (JSON) OR upload file resource to R2 (multipart/form-data)
app.post('/api/admin/resources', async (c) => {
  const contentType = c.req.header('Content-Type') || '';
  const now = new Date().toISOString();
  const id = `res-${crypto.randomUUID()}`;

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const categoryId = String(formData.get('categoryId') || '').trim();
    const title = String(formData.get('title') || '').trim();
    const description = String(formData.get('description') || '').trim();
    const isPinned = formData.get('isPinned') === 'true' || formData.get('isPinned') === 'on';
    const rawFile = formData.get('file') as unknown;
    const file = rawFile instanceof File ? rawFile : null;

    if (!categoryId || title.length < 2) {
      return c.json({ error: 'Category and title (at least 2 characters) are required.' }, 400);
    }

    if (!file || file.size === 0) {
      return c.json({ error: 'Please select a file to upload.' }, 400);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'File is too large. Maximum upload size is 25 MB.' }, 400);
    }

    const cat = await c.env.DB.prepare('SELECT id FROM categories WHERE id = ?')
      .bind(categoryId)
      .first<{ id: string }>();
    if (!cat) {
      return c.json({ error: 'Selected category does not exist.' }, 400);
    }

    const safeName = sanitizeFileName(file.name);
    const fileKey = `resources/${id}/${safeName}`;
    const mimeType = file.type || 'application/octet-stream';

    await c.env.FILES.put(fileKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalName: safeName, resourceId: id },
    });

    await c.env.DB.prepare(
      `INSERT INTO resources (
        id, category_id, title, description, type, url, file_key, file_name, file_size, mime_type, is_pinned, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'file', NULL, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(id, categoryId, title, description, fileKey, safeName, file.size, mimeType, isPinned ? 1 : 0, now, now)
      .run();

    const created = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?')
      .bind(id)
      .first<ResourceRow>();

    return c.json({ resource: created ? mapResourceRow(created) : null }, 201);
  }

  // JSON link resource
  const body = await c.req.json().catch(() => null);
  const parsed = CreateLinkResourceInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid link details.' }, 400);
  }

  const cat = await c.env.DB.prepare('SELECT id FROM categories WHERE id = ?')
    .bind(parsed.data.categoryId)
    .first<{ id: string }>();
  if (!cat) {
    return c.json({ error: 'Selected category does not exist.' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO resources (
      id, category_id, title, description, type, url, file_key, file_name, file_size, mime_type, is_pinned, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'link', ?, NULL, NULL, NULL, NULL, ?, 0, ?, ?)`
  )
    .bind(
      id,
      parsed.data.categoryId,
      parsed.data.title,
      parsed.data.description,
      parsed.data.url,
      parsed.data.isPinned ? 1 : 0,
      now,
      now
    )
    .run();

  const created = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?')
    .bind(id)
    .first<ResourceRow>();

  return c.json({ resource: created ? mapResourceRow(created) : null }, 201);
});

// Admin: Edit resource metadata (or pin/unpin)
app.patch('/api/admin/resources/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?')
    .bind(id)
    .first<ResourceRow>();

  if (!existing) {
    return c.json({ error: 'Resource not found.' }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateResourceInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid update payload.' }, 400);
  }

  const nextCategoryId = parsed.data.categoryId ?? existing.category_id;
  const nextTitle = parsed.data.title ?? existing.title;
  const nextDescription = parsed.data.description ?? existing.description;
  const nextUrl = existing.type === 'link' ? (parsed.data.url ?? existing.url) : null;
  const nextPinned = parsed.data.isPinned !== undefined ? (parsed.data.isPinned ? 1 : 0) : existing.is_pinned;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE resources
     SET category_id = ?, title = ?, description = ?, url = ?, is_pinned = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(nextCategoryId, nextTitle, nextDescription, nextUrl, nextPinned, now, id)
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?')
    .bind(id)
    .first<ResourceRow>();

  return c.json({ resource: updated ? mapResourceRow(updated) : null });
});

// Admin: Delete resource (and remove object from R2 if it is an uploaded file)
app.delete('/api/admin/resources/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, type, file_key FROM resources WHERE id = ?')
    .bind(id)
    .first<Pick<ResourceRow, 'id' | 'type' | 'file_key'>>();

  if (!existing) {
    return c.json({ error: 'Resource not found.' }, 404);
  }

  if (existing.type === 'file' && existing.file_key) {
    await c.env.FILES.delete(existing.file_key);
  }

  await c.env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'Endpoint not found.' }, 404));

app.onError((err, c) => {
  console.error('API Error:', err);
  return c.json({ error: 'Unexpected server error.' }, 500);
});

export default app;
