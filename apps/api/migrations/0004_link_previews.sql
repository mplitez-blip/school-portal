-- Cache website link preview metadata on resources

ALTER TABLE resources ADD COLUMN preview_title TEXT;
ALTER TABLE resources ADD COLUMN preview_description TEXT;
ALTER TABLE resources ADD COLUMN preview_image TEXT;
ALTER TABLE resources ADD COLUMN preview_site_name TEXT;
ALTER TABLE resources ADD COLUMN preview_favicon TEXT;
ALTER TABLE resources ADD COLUMN preview_fetched_at TEXT;
