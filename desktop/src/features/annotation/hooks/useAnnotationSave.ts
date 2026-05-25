import type React from "react";
import { api } from "../../../api";
import type { DatasetDetail } from "../../../types";
import { annotationPayload, mapAnnotationBox } from "../annotationBoxUtils";
import type { AnnotationBox, AnnotationSnapshot } from "../annotationTypes";

type DraftMap = Map<number, { boxes: AnnotationBox[]; deletedIds: number[] }>;
type SaveStatus = "idle" | "saving" | "saved" | "error";

type UseAnnotationSaveArgs = {
  selected: DatasetDetail["media"][number] | undefined;
  selectedDatasetId: number | null;
  boxes: AnnotationBox[];
  deletedIds: number[];
  draftsRef: React.MutableRefObject<DraftMap>;
  saveCurrentAsDraft: () => void;
  setBoxes: React.Dispatch<React.SetStateAction<AnnotationBox[]>>;
  setDeletedIds: React.Dispatch<React.SetStateAction<number[]>>;
  setHistory: React.Dispatch<React.SetStateAction<AnnotationSnapshot[]>>;
  setFuture: React.Dispatch<React.SetStateAction<AnnotationSnapshot[]>>;
  setDraftMediaIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  setSaveStatus: React.Dispatch<React.SetStateAction<SaveStatus>>;
  setSaveModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setDatasetMedia: React.Dispatch<React.SetStateAction<DatasetDetail["media"]>>;
  onSaved?: () => void | Promise<void>;
};

export function useAnnotationSave({
  selected,
  selectedDatasetId,
  boxes,
  deletedIds,
  draftsRef,
  saveCurrentAsDraft,
  setBoxes,
  setDeletedIds,
  setHistory,
  setFuture,
  setDraftMediaIds,
  setSaveStatus,
  setSaveModalOpen,
  setMessage,
  setDatasetMedia,
  onSaved,
}: UseAnnotationSaveArgs) {
  const applySavedMediaCounts = (countsByMediaId: Map<number, number>) => {
    setDatasetMedia((current) =>
      current.map((item) => {
        const count = countsByMediaId.get(item.id);
        return count === undefined ? item : { ...item, annotation_count: count, annotation_status: "annotated" as const };
      }),
    );
  };

  const doSaveCurrent = async (): Promise<boolean> => {
    if (!selected || !selectedDatasetId) return false;
    const unsaved = boxes.filter((box) => !box.id);
    const changed = boxes.filter((box) => box.id && box.dirty);
    const totalChanges = unsaved.length + changed.length + deletedIds.length;
    if (totalChanges === 0) {
      draftsRef.current.delete(selected.id);
      setDraftMediaIds(new Set(draftsRef.current.keys()));
      await api.markMediaAnnotated(selectedDatasetId, selected.id);
      applySavedMediaCounts(new Map([[selected.id, boxes.length]]));
      setMessage("\u6807\u6ce8\u5df2\u4fdd\u5b58\u3002");
      return true;
    }
    setSaveStatus("saving");
    setMessage(`\u6b63\u5728\u4fdd\u5b58 ${totalChanges} \u4e2a\u6807\u6ce8\u6539\u52a8`);
    try {
      const result = await api.bulkSaveAnnotations(selected.id, selectedDatasetId, {
        delete_ids: deletedIds,
        upserts: [
          ...changed
            .filter((box) => box.id)
            .map((box) => ({ id: box.id, ...annotationPayload(box) })),
          ...unsaved.map((box) => annotationPayload({ ...box, review_status: "confirmed" })),
        ],
      });
      setBoxes(result.annotations.map(mapAnnotationBox));
      setDeletedIds([]);
      setHistory([]);
      setFuture([]);
      localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selected.id));
      draftsRef.current.delete(selected.id);
      setDraftMediaIds(new Set(draftsRef.current.keys()));
      setSaveStatus("saved");
      setMessage("\u6807\u6ce8\u5df2\u4fdd\u5b58\u3002");
      applySavedMediaCounts(new Map([[selected.id, result.annotations.length]]));
      await onSaved?.();
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "\u4fdd\u5b58\u5931\u8d25");
      return false;
    }
  };

  const doSaveAllDrafts = async (): Promise<boolean> => {
    if (!selectedDatasetId) return false;
    setSaveStatus("saving");
    let totalSaved = 0;
    const savedCounts = new Map<number, number>();
    try {
      if (selected) {
        const unsaved = boxes.filter((box) => !box.id);
        const changed = boxes.filter((box) => box.id && box.dirty);
        const currentChanges = unsaved.length + changed.length + deletedIds.length;
        if (currentChanges > 0) {
          setMessage("\u6b63\u5728\u4fdd\u5b58\u5f53\u524d\u56fe\u7247\u6807\u6ce8...");
          const result = await api.bulkSaveAnnotations(selected.id, selectedDatasetId, {
            delete_ids: deletedIds,
            upserts: [
              ...changed.filter((box) => box.id).map((box) => ({ id: box.id, ...annotationPayload(box) })),
              ...unsaved.map((box) => annotationPayload({ ...box, review_status: "confirmed" })),
            ],
          });
          setBoxes(result.annotations.map(mapAnnotationBox));
          setDeletedIds([]);
          setHistory([]);
          setFuture([]);
          totalSaved += currentChanges;
          savedCounts.set(selected.id, result.annotations.length);
        } else {
          await api.markMediaAnnotated(selectedDatasetId, selected.id);
          savedCounts.set(selected.id, boxes.length);
        }
      }
      for (const [mediaId, draft] of draftsRef.current) {
        if (selected && mediaId === selected.id) continue;
        const draftUnsaved = draft.boxes.filter((b) => !b.id);
        const draftChanged = draft.boxes.filter((b) => b.id && b.dirty);
        const draftChanges = draftUnsaved.length + draftChanged.length + draft.deletedIds.length;
        if (draftChanges > 0) {
          setMessage(`\u6b63\u5728\u4fdd\u5b58\u56fe\u7247 #${mediaId} \u7684\u8349\u7a3f...`);
          const result = await api.bulkSaveAnnotations(mediaId, selectedDatasetId, {
            delete_ids: draft.deletedIds,
            upserts: [
              ...draftChanged.map((box) => ({ id: box.id!, ...annotationPayload(box) })),
              ...draftUnsaved.map((box) => annotationPayload({ ...box, review_status: "confirmed" })),
            ],
          });
          totalSaved += draftChanges;
          savedCounts.set(mediaId, result.annotations.length);
        } else {
          await api.markMediaAnnotated(selectedDatasetId, mediaId);
          savedCounts.set(mediaId, draft.boxes.length);
        }
      }
      draftsRef.current.clear();
      setDraftMediaIds(new Set());
      localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selected?.id));
      setSaveStatus("saved");
      setMessage(`\u5df2\u4fdd\u5b58\u5168\u90e8 ${totalSaved} \u4e2a\u6807\u6ce8\u6539\u52a8\u3002`);
      applySavedMediaCounts(savedCounts);
      await onSaved?.();
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "\u4fdd\u5b58\u5931\u8d25");
      return false;
    }
  };

  const saveAll = async () => {
    if (!selected) return;
    saveCurrentAsDraft();
    const otherDraftKeys = [...draftsRef.current.keys()].filter((id) => id !== selected.id);
    if (otherDraftKeys.length > 0) {
      setSaveModalOpen(true);
      return;
    }
    await doSaveCurrent();
  };

  return { saveAll, doSaveCurrent, doSaveAllDrafts };
}
