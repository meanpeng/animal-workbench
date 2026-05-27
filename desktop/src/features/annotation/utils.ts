import type { DatasetMediaItem } from "../../types";
import type { AnnotationBox, ImageLayout } from "./types";

export const MEDIA_PAGE_SIZE = 100;

export function shortcutLabel(index: number): string | null {
  if (index < 9) return String(index + 1);          // 1-9
  if (index === 9) return "0";                       // 0
  if (index <= 35) return String.fromCharCode(87 + index); // a-z
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

export function makeLocalId(): string {
  return `local-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export function cloneBox(box: AnnotationBox): AnnotationBox {
  return { ...box };
}

export function mapAnnotationBox(item: {
  id: number;
  class_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  review_status: string;
}): AnnotationBox {
  const status =
    item.review_status === "draft" || item.review_status === "rejected" || item.review_status === "confirmed"
      ? item.review_status
      : "confirmed";
  return {
    ...item,
    local_id: `annotation-${item.id}`,
    review_status: status,
    dirty: false,
  };
}

export function annotationPayload(box: AnnotationBox) {
  return {
    class_id: box.class_id,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    review_status: box.review_status,
  };
}

export function imageLayout(
  media: { width: number | null; height: number | null } | undefined,
  canvasWidth = 860,
  canvasHeight = 520,
): ImageLayout {
  const width = media?.width ?? canvasWidth;
  const height = media?.height ?? canvasHeight;
  const scale = Math.min(canvasWidth / width, canvasHeight / height);
  const displayWidth = width * scale;
  const displayHeight = height * scale;
  return {
    x: (canvasWidth - displayWidth) / 2,
    y: (canvasHeight - displayHeight) / 2,
    width: displayWidth,
    height: displayHeight,
  };
}

export function pointInsideImage(point: { x: number; y: number }, layout: ImageLayout): boolean {
  return point.x >= layout.x && point.x <= layout.x + layout.width && point.y >= layout.y && point.y <= layout.y + layout.height;
}

export function normalizePoint(point: { x: number; y: number }, layout: ImageLayout): { x: number; y: number } {
  return {
    x: clamp((point.x - layout.x) / layout.width, 0, 1),
    y: clamp((point.y - layout.y) / layout.height, 0, 1),
  };
}

export function resizeDraftBox(
  draftBox: AnnotationBox,
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  layout: ImageLayout,
): AnnotationBox {
  const normalized = normalizePoint(point, layout);
  const x2 = clamp(normalized.x, 0, 1);
  const y2 = clamp(normalized.y, 0, 1);
  return {
    ...draftBox,
    x: Math.min(anchor.x, x2),
    y: Math.min(anchor.y, y2),
    width: Math.max(Math.abs(x2 - anchor.x), 0.001),
    height: Math.max(Math.abs(y2 - anchor.y), 0.001),
  };
}

export function pixelsToBox(
  x: number,
  y: number,
  width: number,
  height: number,
  layout: ImageLayout,
): { x: number; y: number; width: number; height: number } {
  const box = {
    x: (x - layout.x) / layout.width,
    y: (y - layout.y) / layout.height,
    width: width / layout.width,
    height: height / layout.height,
  };
  const nextWidth = clamp(box.width, 0.001, 1);
  const nextHeight = clamp(box.height, 0.001, 1);
  return {
    width: nextWidth,
    height: nextHeight,
    x: clamp(box.x, 0, 1 - nextWidth),
    y: clamp(box.y, 0, 1 - nextHeight),
  };
}

export function clampBox<T extends AnnotationBox>(box: T): T {
  const width = clamp(box.width, 0.001, 1);
  const height = clamp(box.height, 0.001, 1);
  return {
    ...box,
    width,
    height,
    x: clamp(box.x, 0, 1 - width),
    y: clamp(box.y, 0, 1 - height),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function datasetStats(dataset: { version: number; sample_stats: string }): string {
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

export function datasetTypeName(type: "public" | "user" | "fusion"): string {
  return {
    public: "公开数据集",
    user: "用户数据集",
    fusion: "融合数据集",
  }[type];
}
