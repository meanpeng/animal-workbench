PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  reserve_name TEXT,
  default_dataset_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(default_dataset_id) REFERENCES datasets(id)
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2979ff',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'frame')),
  original_name TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'imported',
  camera_site TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  checksum_sha256 TEXT NOT NULL,
  internal_path TEXT NOT NULL,
  parent_asset_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, checksum_sha256),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_asset_id) REFERENCES media_assets(id)
);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  dataset_type TEXT NOT NULL CHECK(dataset_type IN ('public', 'user', 'fusion')),
  version INTEGER NOT NULL DEFAULT 1,
  composition_rule TEXT NOT NULL DEFAULT '{}',
  sample_stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name, version),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dataset_assets (
  dataset_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  split TEXT NOT NULL DEFAULT 'train' CHECK(split IN ('train', 'val', 'test', 'unassigned')),
  annotation_status TEXT NOT NULL DEFAULT 'unannotated' CHECK(annotation_status IN ('unannotated', 'annotated')),
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(dataset_id, media_asset_id),
  FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY(media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dataset_classes (
  dataset_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(dataset_id, class_id),
  FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS annotation_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  source_model_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'completed', 'archived')),
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_model_id) REFERENCES models(id)
);

CREATE TABLE IF NOT EXISTS annotation_batch_items (
  batch_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reviewed', 'skipped')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(batch_id, media_asset_id),
  FOREIGN KEY(batch_id) REFERENCES annotation_batches(id) ON DELETE CASCADE,
  FOREIGN KEY(media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'draft' CHECK(review_status IN ('draft', 'confirmed', 'rejected')),
  source_prediction_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id),
  FOREIGN KEY(source_prediction_id) REFERENCES predictions(id)
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  class_id INTEGER,
  confidence REAL NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  source_job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE,
  FOREIGN KEY(model_id) REFERENCES models(id),
  FOREIGN KEY(class_id) REFERENCES classes(id)
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  model_kind TEXT NOT NULL DEFAULT 'detector',
  source_experiment_id INTEGER,
  metrics_summary TEXT NOT NULL DEFAULT '{}',
  internal_weight_path TEXT,
  is_recommended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_experiment_id) REFERENCES experiments(id)
);

CREATE TABLE IF NOT EXISTS training_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  dataset_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'exported', 'running', 'completed', 'failed', 'cancelled')),
  params TEXT NOT NULL,
  log_path TEXT,
  runtime_dataset_path TEXT,
  started_at TEXT,
  ended_at TEXT,
  output_model_id INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(dataset_id) REFERENCES datasets(id),
  FOREIGN KEY(output_model_id) REFERENCES models(id)
);

CREATE TABLE IF NOT EXISTS dataset_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('public_download', 'public_import', 'folder_import', 'fusion_build')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
  stage TEXT NOT NULL DEFAULT 'queued',
  percent REAL NOT NULL DEFAULT 0,
  current INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  result_summary TEXT NOT NULL DEFAULT '{}',
  params TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  training_job_id INTEGER,
  name TEXT NOT NULL,
  train_metrics TEXT NOT NULL DEFAULT '{}',
  val_metrics TEXT NOT NULL DEFAULT '{}',
  artifact_refs TEXT NOT NULL DEFAULT '{}',
  best_model_id INTEGER,
  last_model_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(training_job_id) REFERENCES training_jobs(id),
  FOREIGN KEY(best_model_id) REFERENCES models(id),
  FOREIGN KEY(last_model_id) REFERENCES models(id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_project ON media_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_annotations_media ON annotations(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_predictions_media ON predictions(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_training_project ON training_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dataset_jobs_project ON dataset_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dataset_classes_dataset ON dataset_classes(dataset_id, sort_order);
