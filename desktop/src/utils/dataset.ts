import type { Dataset } from "../types";

export function datasetStats(dataset: Dataset): string {
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

export function datasetTypeName(type: Dataset["dataset_type"]): string {
  return {
    public: "公开数据集",
    user: "用户数据集",
    fusion: "融合数据集",
  }[type];
}
