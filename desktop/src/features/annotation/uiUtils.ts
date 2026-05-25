import type { Dataset } from "../../types";

export function shortcutLabel(index: number): string | null {
  if (index < 9) return String(index + 1);
  if (index === 9) return "0";
  if (index <= 35) return String.fromCharCode(87 + index);
  return null;
}

export function truncateName(name: string, maxLen = 28): string {
  if (name.length <= maxLen) return name;
  const head = Math.floor(maxLen * 0.45);
  const tail = maxLen - head - 3;
  return name.slice(0, head) + "..." + name.slice(-tail);
}

export function readableTextColor(hexColor: string): "#0f172a" | "#fff" {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return "#fff";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#0f172a" : "#fff";
}

const PREDICTION_COLORS = [
  "#2979ff",
  "#ff6d00",
  "#d500f9",
  "#00c853",
  "#ff1744",
  "#00b8d4",
  "#ffab00",
  "#651fff",
  "#76ff03",
  "#f50057",
  "#00e5ff",
  "#c6ff00",
];

export function predictedClassColor(className: string): string {
  let hash = 0;
  for (let index = 0; index < className.length; index += 1) {
    hash = (hash * 31 + className.charCodeAt(index)) | 0;
  }
  return PREDICTION_COLORS[Math.abs(hash) % PREDICTION_COLORS.length];
}

export function datasetStats(dataset: Dataset) {
  try {
    const stats = JSON.parse(dataset.sample_stats || "{}") as {
      annotation_status?: string;
      media_count?: number;
      annotation_count?: number;
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
