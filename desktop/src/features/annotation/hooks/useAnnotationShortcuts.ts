import { useEffect, useRef } from "react";
import type { DatasetDetail, Summary } from "../../../types";

type UseAnnotationShortcutsArgs = {
  classes: Summary["classes"];
  imageItems: DatasetDetail["media"];
  selectedId: number | null;
  selectedBoxKey: string | null;
  onChangeClass: (classId: number) => void;
  onDoubleClassShortcut: (classId: number) => boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteSelected: () => void;
  onSelectMedia: (mediaId: number) => void;
};

export function useAnnotationShortcuts({
  classes,
  imageItems,
  selectedId,
  selectedBoxKey,
  onChangeClass,
  onDoubleClassShortcut,
  onUndo,
  onRedo,
  onDeleteSelected,
  onSelectMedia,
}: UseAnnotationShortcutsArgs) {
  const classesRef = useRef(classes);
  const imageItemsRef = useRef(imageItems);
  const selectedIdRef = useRef(selectedId);
  const selectedBoxKeyRef = useRef(selectedBoxKey);
  const changeClassRef = useRef(onChangeClass);
  const doubleClassShortcutRef = useRef(onDoubleClassShortcut);
  const lastClassShortcutRef = useRef<{ classId: number; time: number } | null>(null);
  const undoRef = useRef(onUndo);
  const redoRef = useRef(onRedo);
  const deleteSelectedRef = useRef(onDeleteSelected);
  const selectMediaRef = useRef(onSelectMedia);

  classesRef.current = classes;
  imageItemsRef.current = imageItems;
  selectedIdRef.current = selectedId;
  selectedBoxKeyRef.current = selectedBoxKey;
  changeClassRef.current = onChangeClass;
  doubleClassShortcutRef.current = onDoubleClassShortcut;
  undoRef.current = onUndo;
  redoRef.current = onRedo;
  deleteSelectedRef.current = onDeleteSelected;
  selectMediaRef.current = onSelectMedia;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;

      const key = event.key;
      let classIndex = -1;
      if (key >= "1" && key <= "9") classIndex = key.charCodeAt(0) - 49;
      else if (key === "0") classIndex = 9;
      else if (key >= "a" && key <= "z" && !event.ctrlKey && !event.metaKey && !event.altKey) classIndex = key.charCodeAt(0) - 87;

      const currentClasses = classesRef.current;
      if (classIndex >= 0 && classIndex < currentClasses.length) {
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        event.preventDefault();
        const classId = currentClasses[classIndex].id;
        const now = window.performance.now();
        const last = lastClassShortcutRef.current;
        lastClassShortcutRef.current = { classId, time: now };
        if (!event.repeat && last?.classId === classId && now - last.time <= 450 && doubleClassShortcutRef.current(classId)) {
          lastClassShortcutRef.current = null;
          return;
        }
        changeClassRef.current(classId);
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
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
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedBoxKeyRef.current) {
        event.preventDefault();
        deleteSelectedRef.current();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
