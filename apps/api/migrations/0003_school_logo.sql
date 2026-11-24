-- Add school logo storage metadata to settings

ALTER TABLE settings ADD COLUMN logo_key TEXT;
ALTER TABLE settings ADD COLUMN logo_mime_type TEXT;
