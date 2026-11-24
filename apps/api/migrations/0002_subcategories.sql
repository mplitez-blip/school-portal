-- Add subcategories support and seed Templates subcategories

CREATE TABLE IF NOT EXISTS subcategories (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

ALTER TABLE resources ADD COLUMN subcategory_id TEXT REFERENCES subcategories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_subcategories_category ON subcategories(category_id, sort_order ASC, name ASC);
CREATE INDEX IF NOT EXISTS idx_resources_subcategory ON resources(subcategory_id);

-- Subcategories for Templates (cat-templates)
INSERT OR IGNORE INTO subcategories (id, category_id, slug, name, description, sort_order) VALUES
  ('sub-school-forms', 'cat-templates', 'school-forms-sfs', 'School Forms (SFs)', 'Official School Forms (SF1–SF10) and learner records.', 1),
  ('sub-eclass-record', 'cat-templates', 'eclass-record', 'eClass Record', 'Electronic Class Record spreadsheets and grading sheets.', 2),
  ('sub-exam-tos', 'cat-templates', 'exam-and-tos', 'Exam and TOS', 'Quarterly exam templates and Table of Specifications (TOS).', 3),
  ('sub-admin-forms', 'cat-templates', 'admin-forms', 'Admin Forms', 'Administrative, office, and school management forms.', 4);
