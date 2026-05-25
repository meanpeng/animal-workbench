export type AnnotationBox = {
  local_id: string;
  id?: number;
  class_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  review_status: "draft" | "confirmed" | "rejected";
  dirty?: boolean;
  predicted_class_name?: string;
  confidence?: number;
  source?: "manual" | "assistant";
};

export type AnnotationSnapshot = {
  boxes: AnnotationBox[];
  deletedIds: number[];
};
