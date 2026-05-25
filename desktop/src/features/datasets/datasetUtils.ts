import type { Dataset, DatasetJob } from "../../types";

export function defaultFusionDatasetName() {
  return `融合数据集 - ${new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function latestJobForDataset(jobs: DatasetJob[], key: string) {
  return jobs.find((job) => {
    try {
      const params = JSON.parse(job.params);
      return params.key === key || params.dataset_key === key || params.public_dataset_key === key;
    } catch {
      return false;
    }
  });
}

export function stageName(stage: string) {
  return (
    {
      queued: "排队",
      downloading: "下载",
      extracting: "解压",
      scanning: "扫描",
      extracting_frames: "提取视频帧",
      parsing: "解析",
      importing_media: "导入素材",
      saving_annotations: "写入标注",
      building: "构建",
      finalizing: "收尾",
      completed: "完成",
      failed: "失败",
    } as Record<string, string>
  )[stage] ?? stage;
}

export function jobTypeName(type: DatasetJob["job_type"]) {
  return {
    public_download: "公开数据下载",
    public_import: "公开数据加载",
    folder_import: "文件夹导入",
    fusion_build: "融合数据集构建",
  }[type];
}

export function datasetStats(dataset: Dataset) {
  try {
    const stats = JSON.parse(dataset.sample_stats || "{}") as {
      annotation_status?: string;
      media_count?: number;
      annotation_count?: number;
      format?: string;
    };
    const status = stats.annotation_status === "unlabeled" ? "未标注" : stats.annotation_status === "labeled" ? "已标注" : `v${dataset.version}`;
    if (stats.media_count !== undefined) {
      return `${status} · ${stats.media_count} 素材 · ${stats.annotation_count ?? 0} 框`;
    }
    return status;
  } catch {
    return `v${dataset.version}`;
  }
}

export function datasetTypeName(type: Dataset["dataset_type"]) {
  return {
    public: "公开数据集",
    user: "用户数据集",
    fusion: "融合数据集",
  }[type];
}
