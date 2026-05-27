import { useCallback, useRef, useState } from "react";
import type { AnnotationBox, AnnotationSnapshot } from "../types";
import { cloneBox } from "../utils";

export function useAnnotationHistory() {
  const [history, setHistory] = useState<AnnotationSnapshot[]>([]);
  const [future, setFuture] = useState<AnnotationSnapshot[]>([]);

  const boxesRef = useRef<AnnotationBox[]>([]);
  const deletedIdsRef = useRef<number[]>([]);

  const snapshot = useCallback((): AnnotationSnapshot => ({
    boxes: boxesRef.current.map(cloneBox),
    deletedIds: [...deletedIdsRef.current],
  }), []);

  const commitHistory = useCallback(() => {
    setHistory((current) => [...current, snapshot()].slice(-40));
    setFuture([]);
  }, [snapshot]);

  const restoreSnapshot = useCallback(
    (
      next: AnnotationSnapshot,
      setBoxes: React.Dispatch<React.SetStateAction<AnnotationBox[]>>,
      setDeletedIds: React.Dispatch<React.SetStateAction<number[]>>,
      clearDraft: () => void,
      setSelectedBoxKey: React.Dispatch<React.SetStateAction<string | null>>,
    ) => {
      setBoxes(next.boxes.map(cloneBox));
      setDeletedIds([...next.deletedIds]);
      clearDraft();
      setSelectedBoxKey(null);
    },
    [],
  );

  const undo = useCallback(
    (
      setBoxes: React.Dispatch<React.SetStateAction<AnnotationBox[]>>,
      setDeletedIds: React.Dispatch<React.SetStateAction<number[]>>,
      clearDraft: () => void,
      setSelectedBoxKey: React.Dispatch<React.SetStateAction<string | null>>,
      setMessage: React.Dispatch<React.SetStateAction<string>>,
    ) => {
      setHistory((current) => {
        const previous = current[current.length - 1];
        if (!previous) return current;
        setFuture((items) => [snapshot(), ...items].slice(0, 40));
        restoreSnapshot(previous, setBoxes, setDeletedIds, clearDraft, setSelectedBoxKey);
        setMessage("已撤销上一步编辑。");
        return current.slice(0, -1);
      });
    },
    [snapshot, restoreSnapshot],
  );

  const redo = useCallback(
    (
      setBoxes: React.Dispatch<React.SetStateAction<AnnotationBox[]>>,
      setDeletedIds: React.Dispatch<React.SetStateAction<number[]>>,
      clearDraft: () => void,
      setSelectedBoxKey: React.Dispatch<React.SetStateAction<string | null>>,
      setMessage: React.Dispatch<React.SetStateAction<string>>,
    ) => {
      setFuture((current) => {
        const next = current[0];
        if (!next) return current;
        setHistory((items) => [...items, snapshot()].slice(-40));
        restoreSnapshot(next, setBoxes, setDeletedIds, clearDraft, setSelectedBoxKey);
        setMessage("已重做上一步编辑。");
        return current.slice(1);
      });
    },
    [snapshot, restoreSnapshot],
  );

  return {
    history,
    future,
    setHistory,
    setFuture,
    boxesRef,
    deletedIdsRef,
    commitHistory,
    undo,
    redo,
  };
}
