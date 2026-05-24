export type Project = {
  id: number;
  name: string;
  reserve_name: string | null;
};

export type ClassItem = {
  id: number;
  name: string;
  display_name: string;
  color: string;
  sort_order: number;
};

export type Summary = {
  project: Project;
  classes: ClassItem[];
  counts: Record<string, number>;
  recent_jobs: TrainingJob[];
  recent_models: ModelItem[];
};

export type MediaAsset = {
  id: number;
  media_type: "image" | "video" | "frame";
  original_name: string;
  camera_site: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
};

export type Dataset = {
  id: number;
  name: string;
  dataset_type: "public" | "user" | "fusion";
  version: number;
  sample_stats: string;
  updated_at: string;
};

export type PublicDataset = {
  key: string;
  name: string;
  annotation_format: string;
  description: string;
  default_sample_limit: number | null;
  local_path: string;
  downloaded: boolean;
  importable: boolean;
};

export type DatasetJob = {
  id: number;
  job_type: "public_download" | "public_import" | "folder_import";
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  percent: number;
  current: number;
  total: number;
  message: string;
  log: string;
  error_message: string | null;
  result_summary: string;
  params: string;
  created_at: string;
  updated_at: string;
};

export type AnnotationPayload = {
  class_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  review_status: "draft" | "confirmed" | "rejected";
};

export type AnnotationItem = AnnotationPayload & {
  id: number;
  media_asset_id: number;
};

export type AnnotationBatch = {
  id: number;
  name: string;
  status: "open" | "in_progress" | "completed" | "archived";
  total_items: number;
  completed_items: number;
  updated_at: string;
};

export type TrainingJob = {
  id: number;
  name: string;
  dataset_id: number;
  status: "queued" | "exported" | "running" | "completed" | "failed" | "cancelled";
  params: string;
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  error_message?: string | null;
};

export type DatasetMediaItem = {
  id: number;
  media_type: string;
  original_name: string;
  internal_path: string;
  camera_site: string | null;
  width: number | null;
  height: number | null;
  annotation_count: number;
  class_names: string[];
};

export type DatasetDetail = {
  dataset: Dataset;
  classes: ClassItem[];
  stats: {
    total_media: number;
    annotated_media: number;
    total_annotations: number;
    class_counts: Record<string, number>;
  };
  media: DatasetMediaItem[];
  total: number;
};

export type ModelItem = {
  id: number;
  name: string;
  metrics_summary: string;
  is_recommended: number;
  created_at: string;
};

export type Experiment = {
  id: number;
  name: string;
  val_metrics: string;
  artifact_refs: string;
  created_at: string;
};
