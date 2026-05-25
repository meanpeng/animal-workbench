import type { AnnotationBox } from "./annotationTypes";

export type ImageLayout = ReturnType<typeof imageLayout>;
export type Point = { x: number; y: number };
type ImageSize = { width?: number | null; height?: number | null };

export function imageLayout(media: ImageSize | undefined, canvasWidth = 860, canvasHeight = 520) {
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

export function pointInsideImage(point: Point, layout: ImageLayout) {
  return point.x >= layout.x && point.x <= layout.x + layout.width && point.y >= layout.y && point.y <= layout.y + layout.height;
}

export function normalizePoint(point: Point, layout: ImageLayout) {
  return {
    x: clamp((point.x - layout.x) / layout.width, 0, 1),
    y: clamp((point.y - layout.y) / layout.height, 0, 1),
  };
}

export function resizeDraftBox(
  draftBox: AnnotationBox,
  anchor: Point,
  point: Point,
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

export function pixelsToBox(x: number, y: number, width: number, height: number, layout: ImageLayout) {
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
