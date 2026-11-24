# School Teacher Portal (Hono + Astro on Cloudflare)

A lightweight, teacher-friendly school portal built with a decoupled **Hono** API on **Cloudflare Workers (D1 + R2)** and a static **Astro** frontend deployed on **Cloudflare Workers Static Assets**—ready for a future native **Android** app sharing the exact same API.

## Architecture

```text
school-portal/
├── packages/
│   └── shared/       # Shared TypeScript types & Zod validation schemas
└── apps/
    ├── api/          # Hono REST API (Cloudflare Workers + D1 + R2)
    └── web/          # Astro static frontend (Cloudflare Workers Static Assets)
```

### Features
- **Zero-login Teacher Portal (`/`)**: Big clear buttons, instant search, "Quick Access" pinned strip, and single-row category tabs (*All Resources*, *Submission Links*, *Templates*, *Downloads*).
- **Admin Dashboard (`/admin`)**:
  - Change the **School Name**, subtitle, and optional top announcement banner (updates live with no frontend rebuild).
  - Add external submission links (Google Forms, Docs, etc.) or upload files (`.pdf`, `.docx`, `.xlsx`, etc. up to 25 MB) directly to **Cloudflare R2**.
  - Pin/unpin, edit, and delete items (deleting a file also cleans up the object in R2).
  - Change the admin password from the dashboard.
- **Mobile & Android-Ready**: Includes a PWA manifest so teachers can "Add to Home Screen" now, plus clean JSON endpoints for a future Android app.

---

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Initialize the local D1 database (schema + starter items):**
   ```bash
   npm run db:migrate:local
   ```

3. **Start the Hono API Worker (port `8787`, with local D1 + R2 emulation):**
   ```bash
   npm run dev:api
   ```

4. **In a second terminal, start the Astro frontend (port `4321`):**
   ```bash
   npm run dev:web
   ```

5. **Open in your browser:**
   - Teacher Portal: `http://localhost:4321`
   - Admin Dashboard: `http://localhost:4321/admin`
   - Default local admin login: **`admin`** / **`school1234`** *(change immediately in Admin -> School Settings)*

---

## Deploying to Cloudflare (D1 + R2 + Workers Static Assets)

### 1. Create Cloudflare D1 Database & R2 Bucket
```bash
cd apps/api
npx wrangler login
npx wrangler d1 create school-portal-db
npx wrangler r2 bucket create school-portal-files
```
Copy the `database_id` printed by `wrangler d1 create` into `apps/api/wrangler.jsonc`.

### 2. Apply Remote D1 Migration & Set Secrets
```bash
# From repo root
npm run db:migrate:remote

# Set production JWT secret (use a long random string)
cd apps/api
npx wrangler secret put JWT_SECRET

# Optional: set an initial admin password before your first login
npx wrangler secret put ADMIN_DEFAULT_PASSWORD
```

### 3. Deploy the Hono API Worker
```bash
npm run deploy:api
```
Note your deployed Worker URL, e.g. `https://school-portal-api.<your-subdomain>.workers.dev`.

### 4. Build & Deploy the Astro Frontend (Cloudflare Workers Static Assets)
Create `apps/web/.env` with your live API URL:
```env
PUBLIC_API_URL=https://school-portal-api.<your-subdomain>.workers.dev
```
Then build and deploy:
```bash
npm run deploy:web
```
*(Optional)* Restrict `CORS_ORIGIN` in `apps/api/wrangler.jsonc` to your deployed web URL once live.

---

## REST API Reference (For Future Android App)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Public | Health check |
| `GET` | `/api/portal` | Public | Returns `{ settings, categories, resources }` in one request |
| `GET` | `/api/files/:id` | Public | Streams a file download directly from R2 |
| `POST` | `/api/auth/login` | Public | Returns `{ token, user }` JWT Bearer token |
| `GET` | `/api/auth/me` | Bearer | Verifies admin token |
| `POST` | `/api/auth/change-password` | Bearer | Updates admin password |
| `PATCH` | `/api/admin/settings` | Bearer | Updates `schoolName`, `tagline`, `announcement` |
| `POST` | `/api/admin/resources` | Bearer | Creates link (JSON) or uploads file to R2 (`multipart/form-data`) |
| `PATCH` | `/api/admin/resources/:id` | Bearer | Updates title, description, category, url, or `isPinned` |
| `DELETE` | `/api/admin/resources/:id` | Bearer | Deletes resource from D1 (and object from R2 if file) |
