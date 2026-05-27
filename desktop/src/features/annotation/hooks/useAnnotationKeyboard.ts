import { useEffect, useRef } from "react";
import type { ClassItem, DatasetMediaItem } from "../../../types";

export function useAnnotationKeyboard({
  imageItems,
  selectedId,
  selectedBoxKey,
  datasetClasses,
  changeClass,
  undo,
  redo,
  deleteSelected,
  selectMedia,
}: {
  imageItems: DatasetMediaItem[];
  selectedId: number | null;
  selectedBoxKey: string | null;
  datasetClasses: ClassItem[];
  changeClass: (classId: number) => void;
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
  selectMedia: (mediaId: number) => void;
}) {
  const imageItemsRef = useRef(imageItems);
  imageItemsRef.current = imageItems;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedBoxKeyRef = useRef(selectedBoxKey);
  selectedBoxKeyRef.current = selectedBoxKey;
  const changeClassRef = useRef(changeClass);
  changeClassRef.current = changeClass;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;
  const selectMediaRef = useRef(selectMedia);
  selectMediaRef.current = selectMedia;
  const classesRef = useRef(datasetClasses);
  classesRef.current = datasetClasses;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const currentClasses = classesRef.current;
      // number/letter keys for class selection: 1-9 -> class 1-9, 0 -> class 10, a-z -> class 11-36
      const key = event.key;
      let classIndex = -1;
      if (key >= "1" && key <= "9") classIndex = key.charCodeAt(0) - 49;
      else if (key === "0") classIndex = 9;
      else if (key >= "a" && key <= "z") classIndex = key.charCodeAt(0) - 87;
      if (classIndex >= 0 && classIndex < currentClasses.length) {
        const tag = (event.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        event.preventDefault();
        changeClassRef.current(currentClasses[classIndex].id);
        return;
      }
      // arrow keys to navigate images
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const tag = (event.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        event.preventDefault();
        const currentItems = imageItemsRef.current;
        const currentId = selectedIdRef.current;
        const idx = currentItems.findIndex((item) => item.id === currentId);
        if (event.key === "ArrowLeft" && idx > 0) selectMediaRef.current(currentItems[idx - 1].id);
        else if (event.key === "ArrowRight" && idx < currentItems.length - 1) selectMediaRef.current(currentItems[idx + 1].id);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoRef.current();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoRef.current();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedBoxKeyRef.current) {
          event.preventDefault();
          deleteSelectedRef.current();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
