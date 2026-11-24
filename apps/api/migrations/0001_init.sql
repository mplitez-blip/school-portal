-- Initial D1 schema for School Portal

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  school_name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  announcement TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('link', 'file')),
  url TEXT,
  file_key TEXT,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category_id, is_pinned DESC, sort_order ASC, updated_at DESC);

-- Default School Settings
INSERT OR IGNORE INTO settings (id, school_name, tagline, announcement)
VALUES (
  1,
  'Maplewood Elementary School',
  'Teacher Resource & Submission Hub',
  'Welcome! Bookmark this page for quick access to weekly submissions, forms, and downloadable templates.'
);

-- Default Categories
INSERT OR IGNORE INTO categories (id, slug, name, description, sort_order) VALUES
  ('cat-submissions', 'submissions', 'Submission Links', 'Online forms for attendance, lesson plans, and reports.', 1),
  ('cat-templates', 'templates', 'Templates', 'Ready-to-use lesson plans, rubrics, and grade sheets.', 2),
  ('cat-downloads', 'downloads', 'Downloads', 'School calendars, handbooks, and official memos.', 3);

-- Helpful starter items (admin can edit or delete any of these)
INSERT OR IGNORE INTO resources (id, category_id, title, description, type, url, is_pinned, sort_order) VALUES
  (
    'res-attendance',
    'cat-submissions',
    'Daily Attendance Form',
    'Submit morning student attendance before 8:30 AM.',
    'link',
    'https://forms.gle/example-attendance',
    1,
    1
  ),
  (
    'res-lesson-plan-submit',
    'cat-submissions',
    'Weekly Lesson Plan Submission',
    'Upload or link your weekly lesson plan every Friday.',
    'link',
    'https://forms.gle/example-lesson-plan',
    1,
    2
  ),
  (
    'res-leave-request',
    'cat-submissions',
    'Leave & Substitute Request Form',
    'Request planned leave or notify the office for a substitute teacher.',
    'link',
    'https://forms.gle/example-leave-request',
    0,
    3
  ),
  (
    'res-lesson-template',
    'cat-templates',
    'Weekly Lesson Plan Template (Google Docs)',
    'Click File -> Make a copy to start a new weekly plan.',
    'link',
    'https://docs.google.com/document/d/example-lesson-template',
    1,
    1
  ),
  (
    'res-grade-sheet',
    'cat-templates',
    'Quarterly Grade Sheet Template',
    'Standard spreadsheet layout with automatic averages.',
    'link',
    'https://docs.google.com/spreadsheets/d/example-grade-sheet',
    0,
    2
  ),
  (
    'res-calendar',
    'cat-downloads',
    'School Year Calendar & Holidays',
    'Official academic schedule, grading periods, and school events.',
    'link',
    'https://example.edu/school-calendar.pdf',
    0,
    1
  );
