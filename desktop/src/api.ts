import type {
  AnnotationBatch,
  AnnotationItem,
  AnnotationPayload,
  DatasetJob,
  Dataset,
  DatasetDetail,
  DeviceStatus,
  DatasetTrainingSummary,
  Experiment,
  MediaAsset,
  ModelProfile,
  ModelItem,
  PublicDataset,
  StorageSettings,
  Summary,
  TrainingJob,
  TrainingLog,
} from "./types";

export const API_BASE = import.meta.env.VITE_WORKBENCH_API ?? "http://127.0.0.1:8765";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `API request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean; workspace: string }>("/health"),
  storageSettings: () => request<StorageSettings>("/settings/storage"),
  updateStorageSettings: (payload: { data_root: string }) =>
    request<StorageSettings>("/settings/storage", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  summary: () => request<Summary>("/summary"),
  media: () => request<MediaAsset[]>("/media"),
  importMedia: (paths: string[], batchName: string, extractFrames = false) =>
    request<{ imported: MediaAsset[]; skipped: string[]; batch: AnnotationBatch | null }>("/media/import", {
      method: "POST",
      body: JSON.stringify({ paths, batch_name: batchName || undefined, extract_frames: extractFrames }),
    }),
  mediaContentUrl: (mediaAssetId: number) => `${API_BASE}/media/${mediaAssetId}/content`,
  cleanupOrphanMedia: () =>
    request<{ deleted_rows: number; deleted_files: number }>("/media/cleanup-orphans", {
      method: "POST",
    }),
  annotationsForMedia: (mediaAssetId: number, datasetId?: number) =>
    request<{
      annotations: AnnotationItem[];
      predictions: unknown[];
    }>(`/media/${mediaAssetId}/annotations?${new URLSearchParams(
      Object.fromEntries(Object.entries({ dataset_id: datasetId }).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    ).toString()}`),
  datasets: () => request<Dataset[]>("/datasets"),
  publicDatasets: () => request<PublicDataset[]>("/public-datasets"),
  datasetJobs: () => request<DatasetJob[]>("/dataset-jobs"),
  datasetJob: (jobId: number) => request<DatasetJob>(`/dataset-jobs/${jobId}`),
  datasetJobEventsUrl: (jobId: number) => `${API_BASE}/dataset-jobs/${jobId}/events`,
  bulkSaveAnnotations: (
    mediaAssetId: number,
    datasetId: number,
    payload: { upserts: Array<Partial<Pick<AnnotationItem, "id">> & AnnotationPayload>; delete_ids: number[] },
  ) =>
    request<{ annotations: AnnotationItem[] }>(`/media/${mediaAssetId}/annotations/bulk?dataset_id=${datasetId}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  markMediaAnnotated: (datasetId: number, mediaAssetId: number) =>
    request<{ ok: boolean }>(`/datasets/${datasetId}/media/${mediaAssetId}/annotation-status?status=annotated`, {
      method: "PUT",
    }),
  importDatasetFolder: (payload: {
    path: string;
    name?: string;
    dataset_kind?: "auto" | "labeled" | "unlabeled";
    batch_name?: string;
    create_dataset?: boolean;
    extract_frames?: boolean;
    target_dataset?: { mode: "new"; name: string } | { mode: "existing"; dataset_id: number };
  }) =>
    request<DatasetJob>("/dataset-jobs/import-folder", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  downloadPublicDataset: (key: string, payload: { sample_limit?: number; force?: boolean } = {}) =>
    request<DatasetJob>(`/dataset-jobs/public/${key}/download`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  importPublicDataset: (
    key: string,
    payload: { sample_limit?: number; source_path?: string; force?: boolean } = {},
  ) =>
    request<DatasetJob>(`/dataset-jobs/public/${key}/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createDataset: (payload: { name: string; dataset_type: Dataset["dataset_type"]; media_asset_ids: number[] }) =>
    request<Dataset>("/datasets", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createFusionDataset: (payload: { name: string; source_dataset_ids: number[] }) =>
    request<Dataset>("/datasets/fusion", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createFusionDatasetJob: (payload: { name: string; source_dataset_ids: number[] }) =>
    request<DatasetJob>("/dataset-jobs/fusion", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  addMediaToDataset: (datasetId: number, mediaAssetIds: number[]) =>
    request<Dataset>(`/datasets/${datasetId}/media`, {
      method: "POST",
      body: JSON.stringify({ media_asset_ids: mediaAssetIds }),
    }),
  deleteDataset: (datasetId: number) =>
    request<{ deleted: number }>(`/datasets/${datasetId}`, {
      method: "DELETE",
    }),
  datasetMedia: (
    datasetId: number,
    params?: { limit?: number; offset?: number; search?: string; class_id?: number; annotation_status?: string; media_asset_id?: number },
  ) => request<DatasetDetail>(`/datasets/${datasetId}/media?${new URLSearchParams(
    Object.fromEntries(
      Object.entries(params ?? {}).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
    )
  ).toString()}`),
  batches: () => request<AnnotationBatch[]>("/annotation-batches"),
  jobs: (status?: string) => request<TrainingJob[]>(`/training-jobs${status && status !== "all" ? `?status=${encodeURIComponent(status)}` : ""}`),
  trainingJob: (jobId: number) => request<TrainingJob>(`/training-jobs/${jobId}`),
  trainingJobEventsUrl: (jobId: number) => `${API_BASE}/training-jobs/${jobId}/events`,
  trainingJobLog: (jobId: number, tail = 200) => request<TrainingLog>(`/training-jobs/${jobId}/log?tail=${tail}`),
  cancelTrainingJob: (jobId: number) => request<TrainingJob>(`/training-jobs/${jobId}/cancel`, { method: "POST" }),
  retryTrainingJob: (jobId: number) => request<TrainingJob>(`/training-jobs/${jobId}/retry`, { method: "POST" }),
  resumeTrainingJob: (jobId: number) => request<TrainingJob>(`/training-jobs/${jobId}/resume`, { method: "POST" }),
  datasetTrainingSummary: (datasetId: number) => request<DatasetTrainingSummary>(`/datasets/${datasetId}/training-summary`),
  trainingDeviceStatus: () => request<DeviceStatus>("/training/device-status"),
  modelProfile: (payload: { model_id?: number; model_path?: string }) =>
    request<ModelProfile>("/training/model-profile", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createTrainingJob: (payload: {
    dataset_id: number;
    name: string;
    epochs: number;
    image_size: number;
    batch_size: number;
    device: string;
    mode: "train" | "resume";
    base_model_id?: number;
    base_model_path?: string;
    resume_job_id?: number;
    checkpoint_path?: string;
    run_yolo: boolean;
    advanced?: {
      freeze_layers?: number;
      lr0?: number;
      patience?: number;
      seed?: number;
      workers?: number;
      cache?: boolean;
      augment?: boolean;
      optimizer?: string;
    };
  }) =>
    request<TrainingJob>("/training-jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  models: () => request<ModelItem[]>("/models"),
  experiments: () => request<Experiment[]>("/experiments"),
  exportAnnotations: (datasetId: number, datasetName: string) => {
    const url = `${API_BASE}/datasets/${datasetId}/annotations/export`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${datasetName.replace(/[/\\]/g, "_")}_annotations.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  },
  importAnnotations: (datasetId: number, folderPath: string) =>
    request<{ ok: boolean; matched_media: number; imported_boxes: number; classes: string[]; format: string }>(
      `/datasets/${datasetId}/annotations/import`,
      {
        method: "POST",
        body: JSON.stringify({ folder_path: folderPath }),
      },
    ),
  datasetClasses: (datasetId: number) => request<Summary["classes"]>(`/datasets/${datasetId}/classes`),
  createDatasetClass: (datasetId: number, payload: { name: string; display_name: string; color?: string }) =>
    request<{ id: number }>(`/datasets/${datasetId}/classes`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
