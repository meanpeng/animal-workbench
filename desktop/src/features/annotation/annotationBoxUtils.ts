import type { AnnotationBox } from "./annotationTypes";

export function makeLocalId() {
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
  const payload = {
    class_id: box.class_id,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    review_status: box.review_status,
  };
  return box.class_id <= 0 && box.predicted_class_name
    ? { ...payload, class_name: box.predicted_class_name }
    : payload;
}
