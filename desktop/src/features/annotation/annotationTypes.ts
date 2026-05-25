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
};

export type AnnotationSnapshot = {
  boxes: AnnotationBox[];
  deletedIds: number[];
};
