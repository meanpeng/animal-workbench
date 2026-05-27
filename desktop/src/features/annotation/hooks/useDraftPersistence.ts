import { useCallback, useRef, useState } from "react";
import { api } from "../../../api";
import type { AnnotationBox, DraftState } from "../types";
import { annotationPayload, cloneBox, mapAnnotationBox } from "../utils";

export function useDraftPersistence() {
  const draftsRef = useRef<Map<number, DraftState>>(new Map());
  const [draftMediaIds, setDraftMediaIds] = useState<Set<number>>(new Set());
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const saveCurrentAsDraft = useCallback(
    (
      selectedId: number | null,
      boxesRef: React.MutableRefObject<AnnotationBox[]>,
      deletedIdsRef: React.MutableRefObject<number[]>,
      draftBoxRef: React.MutableRefObject<AnnotationBox | null>,
      draftAnchorRef: React.MutableRefObject<{ x: number; y: number } | null>,
      pendingDraftPointRef: React.MutableRefObject<{ x: number; y: number } | null>,
      setDraftBox: React.Dispatch<React.SetStateAction<AnnotationBox | null>>,
    ) => {
      if (!selectedId) return;
      let currentBoxes = boxesRef.current;
      const currentDraft = draftBoxRef.current;
      if (currentDraft && currentDraft.width >= 0.005 && currentDraft.height >= 0.005) {
        currentBoxes = [...currentBoxes, currentDraft];
      }
      if (currentDraft) {
        draftBoxRef.current = null;
        draftAnchorRef.current = null;
        pendingDraftPointRef.current = null;
        setDraftBox(null);
      }
      const currentDeleted = deletedIdsRef.current;
      draftsRef.current.set(selectedId, {
        boxes: currentBoxes.map(cloneBox),
        deletedIds: [...currentDeleted],
      });
      setDraftMediaIds(new Set(draftsRef.current.keys()));
    },
    [],
  );

  const doSaveCurrent = useCallback(
    async (
      selectedId: number | null,
      selectedDatasetId: number | null,
      boxes: AnnotationBox[],
      deletedIds: number[],
      setBoxes: React.Dispatch<React.SetStateAction<AnnotationBox[]>>,
      setDeletedIds: React.Dispatch<React.SetStateAction<number[]>>,
      setHistory: React.Dispatch<React.SetStateAction<any[]>>,
      setFuture: React.Dispatch<React.SetStateAction<any[]>>,
      setMessage: React.Dispatch<React.SetStateAction<string>>,
    ): Promise<boolean> => {
      if (!selectedId || !selectedDatasetId) return false;
      const unsaved = boxes.filter((box) => !box.id);
      const changed = boxes.filter((box) => box.id && box.dirty);
      const totalChanges = unsaved.length + changed.length + deletedIds.length;
      if (totalChanges === 0) {
        draftsRef.current.delete(selectedId);
        setDraftMediaIds(new Set(draftsRef.current.keys()));
        setMessage("没有标注改动需要保存。");
        return true;
      }
      setSaveStatus("saving");
      setMessage(`正在保存 ${totalChanges} 个标注改动`);
      try {
        const result = await api.bulkSaveAnnotations(selectedId, selectedDatasetId, {
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
        localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selectedId));
        draftsRef.current.delete(selectedId);
        setDraftMediaIds(new Set(draftsRef.current.keys()));
        setSaveStatus("saved");
        setMessage("标注已保存。");
        setTimeout(() => setSaveStatus("idle"), 2000);
        return true;
      } catch (error) {
        setSaveStatus("error");
        setMessage(error instanceof Error ? error.message : "保存失败");
        return false;
      }
    },
    [],
  );

  const doSaveAllDrafts = useCallback(
    async (
      selectedId: number | null,
      selectedDatasetId: number | null,
      boxes: AnnotationBox[],
      deletedIds: number[],
      setBoxes: React.Dispatch<React.SetStateAction<AnnotationBox[]>>,
      setDeletedIds: React.Dispatch<React.SetStateAction<number[]>>,
      setHistory: React.Dispatch<React.SetStateAction<any[]>>,
      setFuture: React.Dispatch<React.SetStateAction<any[]>>,
      setMessage: React.Dispatch<React.SetStateAction<string>>,
    ): Promise<boolean> => {
      if (!selectedDatasetId) return false;
      setSaveStatus("saving");
      let totalSaved = 0;
      try {
        if (selectedId) {
          const unsaved = boxes.filter((box) => !box.id);
          const changed = boxes.filter((box) => box.id && box.dirty);
          const currentChanges = unsaved.length + changed.length + deletedIds.length;
          if (currentChanges > 0) {
            setMessage("正在保存当前图片标注...");
            const result = await api.bulkSaveAnnotations(selectedId, selectedDatasetId, {
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
          }
        }
        for (const [mediaId, draft] of draftsRef.current) {
          if (selectedId && mediaId === selectedId) continue;
          const draftUnsaved = draft.boxes.filter((b) => !b.id);
          const draftChanged = draft.boxes.filter((b) => b.id && b.dirty);
          const draftChanges = draftUnsaved.length + draftChanged.length + draft.deletedIds.length;
          if (draftChanges > 0) {
            setMessage(`正在保存图片 #${mediaId} 的草稿...`);
            await api.bulkSaveAnnotations(mediaId, selectedDatasetId, {
              delete_ids: draft.deletedIds,
              upserts: [
                ...draftChanged.map((box) => ({ id: box.id!, ...annotationPayload(box) })),
                ...draftUnsaved.map((box) => annotationPayload({ ...box, review_status: "confirmed" })),
              ],
            });
            totalSaved += draftChanges;
          }
        }
        draftsRef.current.clear();
        setDraftMediaIds(new Set());
        localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selectedId));
        setSaveStatus("saved");
        setMessage(`已保存全部 ${totalSaved} 个标注改动。`);
        setTimeout(() => setSaveStatus("idle"), 2000);
        return true;
      } catch (error) {
        setSaveStatus("error");
        setMessage(error instanceof Error ? error.message : "保存失败");
        return false;
      }
    },
    [],
  );

  return {
    draftsRef,
    draftMediaIds,
    setDraftMediaIds,
    saveStatus,
    setSaveStatus,
    saveCurrentAsDraft,
    doSaveCurrent,
    doSaveAllDrafts,
  };
}
