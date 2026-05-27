import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClassItem, Dataset, DatasetDetail, DatasetMediaItem } from "../../types";
import { api } from "../../api";
import { useAnnotationHistory } from "./hooks/useAnnotationHistory";
import { useDraftPersistence } from "./hooks/useDraftPersistence";
import { useAnnotationKeyboard } from "./hooks/useAnnotationKeyboard";
import { useHtmlImage } from "./hooks/useHtmlImage";
import { prefetchImage } from "./imageCache";
import { DatasetSelector, MediaSidebar } from "./components/MediaSidebar";
import { AnnotationCanvas } from "./components/AnnotationCanvas";
import { AnnotationToolbar } from "./components/AnnotationToolbar";
import { ClassManager } from "./components/ClassManager";
import { AnnotationModals } from "./components/AnnotationModals";
import type { AnnotationBox, ImageLayout } from "./types";
import {
  MEDIA_PAGE_SIZE,
  makeLocalId,
  cloneBox,
  mapAnnotationBox,
  annotationPayload,
  imageLayout,
  pointInsideImage,
  normalizePoint,
  resizeDraftBox,
  pixelsToBox,
  clampBox,
} from "./utils";
import { sanitizeClassName } from "../../utils/classNames";

export function Annotate({
  datasets,
  initialDatasetId,
  initialMediaId,
  onTargetConsumed,
}: {
  datasets: Dataset[];
  initialDatasetId: number | null;
  initialMediaId: number | null;
  onTargetConsumed: () => void;
}) {
  // ── dataset & media state ──
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(initialDatasetId);
  const [datasetMedia, setDatasetMedia] = useState<DatasetDetail["media"]>([]);
  const [datasetMediaTotal, setDatasetMediaTotal] = useState(0);
  const [mediaPageOffset, setMediaPageOffset] = useState(0);
  const [currentDatasetStats, setCurrentDatasetStats] = useState<DatasetDetail["stats"] | null>(null);
  const [datasetClasses, setDatasetClasses] = useState<ClassItem[]>([]);
  const [loadingDataset, setLoadingDataset] = useState(false);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);
  const mediaListRef = useRef<HTMLDivElement>(null);
  const mediaRequestSeqRef = useRef(0);

  // ── filters ──
  const [statusFilter, setStatusFilter] = useState<"all" | "annotated" | "unannotated">("all");
  const [classFilterId, setClassFilterId] = useState<number | null>(null);

  // ── annotation state ──
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [boxes, setBoxes] = useState<AnnotationBox[]>([]);
  const [draftBox, setDraftBox] = useState<AnnotationBox | null>(null);
  const draftBoxRef = useRef<AnnotationBox | null>(null);
  const draftAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const draftFrameRef = useRef<number | null>(null);
  const pendingDraftPointRef = useRef<{ x: number; y: number } | null>(null);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [selectedBoxKey, setSelectedBoxKey] = useState<string | null>(null);
  const [activeClassId, setActiveClassId] = useState<number>(0);
  const [message, setMessage] = useState("请先选择数据集，再开始标注。");
  const [canvasDims, setCanvasDims] = useState({ width: 860, height: 520 });
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [newClassDisplayName, setNewClassDisplayName] = useState("");
  const [addClassError, setAddClassError] = useState("");
  const [addingClass, setAddingClass] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false);
  const [pendingNavAction, setPendingNavAction] = useState<(() => void) | null>(null);

  // ── hooks ──
  const {
    history, future, setHistory, setFuture, boxesRef, deletedIdsRef, commitHistory, undo: historyUndo, redo: historyRedo,
  } = useAnnotationHistory();
  const {
    draftsRef, draftMediaIds, setDraftMediaIds, saveStatus, setSaveStatus,
    saveCurrentAsDraft, doSaveCurrent, doSaveAllDrafts,
  } = useDraftPersistence();

  // ── refs ──
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<any>(null);
  const transformerRef = useRef<any>(null);
  const targetMediaConsumed = useRef(false);
  const hasUnsavedChangesRef = useRef(false);

  // ── derived ──
  const imageItems = useMemo(() => datasetMedia.filter((item) => item.media_type === "image"), [datasetMedia]);
  const hasMoreMedia = datasetMedia.length < datasetMediaTotal;
  const classById = useMemo(() => new Map(datasetClasses.map((item) => [item.id, item])), [datasetClasses]);
  const selected = useMemo(() => imageItems.find((item) => item.id === selectedId) ?? imageItems[0], [imageItems, selectedId]);
  const image = useHtmlImage(selected?.id ?? null);
  const layout: ImageLayout = imageLayout(selected ?? undefined, canvasDims.width, canvasDims.height);
  const selectedBox = boxes.find((box) => box.local_id === selectedBoxKey);
  const displayedBoxes = useMemo(() => (draftBox ? [...boxes, draftBox] : boxes), [boxes, draftBox]);
  const hasUnsavedChanges = boxes.some((box) => !box.id || box.dirty) || deletedIds.length > 0 || draftBox !== null;
  hasUnsavedChangesRef.current = hasUnsavedChanges;
  boxesRef.current = boxes;
  deletedIdsRef.current = deletedIds;
  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId);
  const totalAnnotated = currentDatasetStats?.annotated_media ?? datasetMedia.filter((m) => m.annotation_count > 0).length;

  // ── draft helpers ──
  const resetDraftState = useCallback(() => {
    draftBoxRef.current = null;
    draftAnchorRef.current = null;
    pendingDraftPointRef.current = null;
    setDraftBox(null);
  }, []);

  const clearDraft = useCallback(() => {
    draftBoxRef.current = null;
    draftAnchorRef.current = null;
    pendingDraftPointRef.current = null;
    setDraftBox(null);
    setSelectedBoxKey(null);
  }, []);

  // ── prefetch adjacent images ──
  useEffect(() => {
    if (!selected) return;
    const idx = imageItems.findIndex((item) => item.id === selected.id);
    if (idx === -1) return;
    for (let i = 1; i <= 3; i++) {
      if (idx - i >= 0) prefetchImage(imageItems[idx - i].id);
      if (idx + i < imageItems.length) prefetchImage(imageItems[idx + i].id);
    }
  }, [selected, imageItems]);

  // ── media query params ──
  const mediaQueryParams = useCallback(
    (offset: number, limit: number, mediaAssetId?: number) => ({
      limit,
      offset,
      class_id: classFilterId ?? undefined,
      annotation_status: statusFilter === "all" ? undefined : statusFilter,
      media_asset_id: mediaAssetId,
    }),
    [classFilterId, statusFilter],
  );

  // ── load dataset media ──
  useEffect(() => {
    if (!selectedDatasetId) {
      setDatasetMedia([]);
      setDatasetMediaTotal(0);
      setMediaPageOffset(0);
      setCurrentDatasetStats(null);
      setDatasetClasses([]);
      setSelectedId(null);
      setStatusFilter("all");
      setClassFilterId(null);
      setBoxes([]);
      resetDraftState();
      setDeletedIds([]);
      setSelectedBoxKey(null);
      draftsRef.current.clear();
      setDraftMediaIds(new Set());
      return;
    }

    let cancelled = false;
    const requestSeq = ++mediaRequestSeqRef.current;
    setDatasetMedia([]);
    setDatasetMediaTotal(0);
    setMediaPageOffset(0);
    setBoxes([]);
    resetDraftState();
    setDeletedIds([]);
    setSelectedBoxKey(null);
    draftsRef.current.clear();
    setDraftMediaIds(new Set());
    setLoadingDataset(true);
    setLoadingMoreMedia(false);
    setMessage("正在加载数据集...");

    const loadFirstPage = async () => {
      try {
        const result = await api.datasetMedia(selectedDatasetId, mediaQueryParams(0, MEDIA_PAGE_SIZE));
        if (cancelled || requestSeq !== mediaRequestSeqRef.current) return;

        let nextMedia = result.media;
        const savedPos = localStorage.getItem(`annotate_pos_${selectedDatasetId}`);
        const savedId = savedPos ? Number(savedPos) : null;
        const desiredId = initialMediaId ?? savedId;

        if (desiredId && !nextMedia.some((m) => m.id === desiredId)) {
          const targetResult = await api.datasetMedia(selectedDatasetId, mediaQueryParams(0, 1, desiredId));
          if (cancelled || requestSeq !== mediaRequestSeqRef.current) return;
          const target = targetResult.media[0];
          if (target) nextMedia = [target, ...nextMedia.filter((m) => m.id !== target.id)];
        }

        setDatasetMedia(nextMedia);
        setDatasetMediaTotal(result.total);
        setMediaPageOffset(result.media.length);
        setCurrentDatasetStats(result.stats);
        setDatasetClasses(result.classes);
        setLoadingDataset(false);

        const desiredLoaded = desiredId ? nextMedia.find((m) => m.id === desiredId && m.media_type === "image") : null;
        const firstImage = nextMedia.find((m) => m.media_type === "image");
        if (desiredLoaded) setSelectedId(desiredLoaded.id);
        else if (firstImage) setSelectedId(firstImage.id);
        else setSelectedId(null);
        setMessage(`已加载 ${nextMedia.length}/${result.total} 个素材`);
      } catch (err) {
        if (!cancelled && requestSeq === mediaRequestSeqRef.current) {
          setMessage(err instanceof Error ? err.message : "加载数据集失败");
          setLoadingDataset(false);
        }
      }
    };

    void loadFirstPage();
    return () => { cancelled = true; };
  }, [selectedDatasetId, mediaQueryParams, initialMediaId]);

  // ── load more media ──
  const loadMoreMedia = useCallback(async () => {
    if (!selectedDatasetId || loadingDataset || loadingMoreMedia || !hasMoreMedia) return;
    setLoadingMoreMedia(true);
    const requestSeq = mediaRequestSeqRef.current;
    try {
      const result = await api.datasetMedia(selectedDatasetId, mediaQueryParams(mediaPageOffset, MEDIA_PAGE_SIZE));
      if (requestSeq !== mediaRequestSeqRef.current) return;
      setDatasetMedia((current) => {
        const existing = new Set(current.map((item) => item.id));
        const additions = result.media.filter((item) => !existing.has(item.id));
        return [...current, ...additions];
      });
      setDatasetMediaTotal(result.total);
      setMediaPageOffset((current) => current + result.media.length);
      setCurrentDatasetStats(result.stats);
      setDatasetClasses(result.classes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载更多素材失败");
    } finally {
      if (requestSeq === mediaRequestSeqRef.current) setLoadingMoreMedia(false);
    }
  }, [hasMoreMedia, loadingDataset, loadingMoreMedia, mediaPageOffset, mediaQueryParams, selectedDatasetId]);

  const handleMediaListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) void loadMoreMedia();
  }, [loadMoreMedia]);

  // ── target media consumption ──
  useEffect(() => {
    if (initialMediaId !== null && !loadingDataset && datasetMedia.length > 0 && !targetMediaConsumed.current) {
      if (datasetMedia.some((m) => m.id === initialMediaId)) {
        targetMediaConsumed.current = true;
        setSelectedId(initialMediaId);
        onTargetConsumed();
      }
    }
  }, [initialMediaId, datasetMedia, loadingDataset, onTargetConsumed]);

  // ── keep activeClassId in sync ──
  useEffect(() => {
    if (datasetClasses.length === 0) setActiveClassId(0);
    else if (!datasetClasses.find((c) => c.id === activeClassId)) setActiveClassId(datasetClasses[0].id);
  }, [datasetClasses, activeClassId]);

  // ── load annotations for selected image ──
  useEffect(() => {
    if (!selected) return;
    if (selectedDatasetId) localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selected.id));
    const draft = draftsRef.current.get(selected.id);
    if (draft) {
      setBoxes(draft.boxes.map(cloneBox));
      setDeletedIds([...draft.deletedIds]);
      setSelectedBoxKey(null);
      setSaveStatus("idle");
      setMessage("已加载草稿标注，可以继续编辑或保存。");
      return;
    }
    let cancelled = false;
    setMessage("正在加载标注...");
    api
      .annotationsForMedia(selected.id, selectedDatasetId ?? undefined)
      .then((result) => {
        if (!cancelled) {
          setBoxes(result.annotations.map(mapAnnotationBox));
          clearDraft();
          setDeletedIds([]);
          setSaveStatus("idle");
          setMessage("已加载标注，可以继续补充或修订。");
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "标注加载失败");
      });
    return () => { cancelled = true; };
  }, [selected, selectedDatasetId]);

  // ── beforeunload warning ──
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (draftsRef.current.size > 0 || hasUnsavedChangesRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // ── cleanup draft animation frame ──
  useEffect(() => {
    return () => {
      if (draftFrameRef.current !== null) window.cancelAnimationFrame(draftFrameRef.current);
      draftBoxRef.current = null;
      draftAnchorRef.current = null;
      pendingDraftPointRef.current = null;
    };
  }, []);

  // ── drawing handlers ──
  const startDraw = useCallback((event: any) => {
    if (!selected) return;
    if (!activeClassId) {
      setMessage("当前数据集还没有类别，请先点击上方\u201c新增\u201d创建类别。");
      return;
    }
    const stage = event.target.getStage();
    const targetName = event.target.name?.();
    const canStart = event.target === stage || targetName === "canvas-bg" || targetName === "image";
    if (!canStart) return;
    const position = stage.getPointerPosition();
    if (!position || !pointInsideImage(position, layout)) {
      setSelectedBoxKey(null);
      return;
    }
    const normalized = normalizePoint(position, layout);
    const nextDraft: AnnotationBox = {
      local_id: makeLocalId(),
      class_id: activeClassId,
      x: normalized.x,
      y: normalized.y,
      width: 0.001,
      height: 0.001,
      review_status: "draft",
    };
    draftBoxRef.current = nextDraft;
    draftAnchorRef.current = normalized;
    pendingDraftPointRef.current = null;
    setSelectedBoxKey(null);
    setDraftBox(nextDraft);
  }, [selected, activeClassId, layout]);

  const updateDraw = useCallback((event: any) => {
    const currentDraft = draftBoxRef.current;
    if (!currentDraft) return;
    const position = event.target.getStage().getPointerPosition();
    if (!position) return;
    pendingDraftPointRef.current = position;
    if (draftFrameRef.current !== null) return;
    draftFrameRef.current = window.requestAnimationFrame(() => {
      draftFrameRef.current = null;
      const point = pendingDraftPointRef.current;
      const draft = draftBoxRef.current;
      const anchor = draftAnchorRef.current;
      if (!point || !draft || !anchor) return;
      const nextDraft = resizeDraftBox(draft, anchor, point, layout);
      draftBoxRef.current = nextDraft;
      setDraftBox(nextDraft);
    });
  }, [layout]);

  const finishDraw = useCallback(() => {
    let finalDraft = draftBoxRef.current;
    if (!finalDraft) return;
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    if (pendingDraftPointRef.current) {
      const anchor = draftAnchorRef.current;
      if (anchor) finalDraft = resizeDraftBox(finalDraft, anchor, pendingDraftPointRef.current, layout);
    }
    draftBoxRef.current = null;
    draftAnchorRef.current = null;
    pendingDraftPointRef.current = null;
    if (finalDraft.width < 0.005 || finalDraft.height < 0.005) {
      setDraftBox(null);
      setMessage("框太小，已忽略。");
      return;
    }
    commitHistory();
    setBoxes((current) => [...current, finalDraft]);
    setSelectedBoxKey(finalDraft.local_id);
    setDraftBox(null);
    setMessage("新框已加入，点击保存写入数据库。");
  }, [layout, commitHistory]);

  // ── box operations ──
  const updateBox = useCallback((localId: string, patch: Partial<AnnotationBox>) => {
    setBoxes((current) =>
      current.map((box) => (box.local_id === localId ? clampBox({ ...box, ...patch, dirty: Boolean(box.id) || box.dirty }) : box)),
    );
  }, []);

  const deleteSelected = useCallback(() => {
    if (!selectedBoxKey) return;
    const box = boxes.find((item) => item.local_id === selectedBoxKey);
    if (!box) return;
    commitHistory();
    setBoxes((current) => current.filter((item) => item.local_id !== selectedBoxKey));
    if (box.id) setDeletedIds((current) => [...new Set([...current, box.id as number])]);
    setSelectedBoxKey(null);
    setMessage(box.id ? "已标记删除，保存后会从 SQLite 移除。" : "已删除未保存的标注框。");
  }, [selectedBoxKey, boxes, commitHistory]);

  const changeClass = useCallback((classId: number) => {
    setActiveClassId(classId);
    if (!selectedBoxKey) return;
    commitHistory();
    updateBox(selectedBoxKey, { class_id: classId });
    setMessage("已更新所选标注类别。");
  }, [selectedBoxKey, commitHistory, updateBox]);

  // ── history wrappers ──
  const undo = useCallback(() => historyUndo(setBoxes, setDeletedIds, clearDraft, setSelectedBoxKey, setMessage), [historyUndo]);
  const redo = useCallback(() => historyRedo(setBoxes, setDeletedIds, clearDraft, setSelectedBoxKey, setMessage), [historyRedo]);

  // ── keyboard shortcuts ──
  useAnnotationKeyboard({
    imageItems,
    selectedId,
    selectedBoxKey,
    datasetClasses,
    changeClass,
    undo,
    redo,
    deleteSelected,
    selectMedia: (mediaId: number) => {
      if (mediaId === selectedId) return;
      saveCurrentAsDraft(selectedId, boxesRef, deletedIdsRef, draftBoxRef, draftAnchorRef, pendingDraftPointRef, setDraftBox);
      setSelectedId(mediaId);
    },
  });

  // ── drag & transform handlers ──
  const handleDragStart = useCallback((box: AnnotationBox, event: any) => {
    event.cancelBubble = true;
    commitHistory();
    setSelectedBoxKey(box.local_id);
  }, [commitHistory]);

  const handleDragEnd = useCallback((box: AnnotationBox, event: any) => {
    const rect = event.target;
    const next = pixelsToBox(rect.x(), rect.y(), rect.width(), rect.height(), layout);
    updateBox(box.local_id, next);
    setMessage("标注框位置已更新。");
  }, [layout, updateBox]);

  const handleTransformStart = useCallback((box: AnnotationBox, event: any) => {
    event.cancelBubble = true;
    commitHistory();
    setSelectedBoxKey(box.local_id);
  }, [commitHistory]);

  const handleTransformEnd = useCallback((box: AnnotationBox, event: any) => {
    const node = event.target;
    const next = pixelsToBox(
      node.x(), node.y(),
      Math.max(node.width() * node.scaleX(), 4),
      Math.max(node.height() * node.scaleY(), 4),
      layout,
    );
    node.scaleX(1);
    node.scaleY(1);
    updateBox(box.local_id, next);
    setMessage("标注框尺寸已更新。");
  }, [layout, updateBox]);

  const handleBoxMouseDown = useCallback((box: AnnotationBox, event: any) => {
    event.cancelBubble = true;
    setSelectedBoxKey(box.local_id);
  }, []);

  // ── save operations ──
  const doSaveCurrentWrapper = useCallback(async (): Promise<boolean> => {
    return doSaveCurrent(selectedId, selectedDatasetId, boxes, deletedIds, setBoxes, setDeletedIds, setHistory, setFuture, setMessage);
  }, [doSaveCurrent, selectedId, selectedDatasetId, boxes, deletedIds]);

  const doSaveAllDraftsWrapper = useCallback(async (): Promise<boolean> => {
    return doSaveAllDrafts(selectedId, selectedDatasetId, boxes, deletedIds, setBoxes, setDeletedIds, setHistory, setFuture, setMessage);
  }, [doSaveAllDrafts, selectedId, selectedDatasetId, boxes, deletedIds]);

  const saveAll = useCallback(async () => {
    if (!selected) return;
    saveCurrentAsDraft(selectedId, boxesRef, deletedIdsRef, draftBoxRef, draftAnchorRef, pendingDraftPointRef, setDraftBox);
    const otherDraftKeys = [...draftsRef.current.keys()].filter((id) => id !== selected.id);
    if (otherDraftKeys.length > 0) {
      setSaveModalOpen(true);
      return;
    }
    await doSaveCurrentWrapper();
  }, [selected, selectedId, saveCurrentAsDraft, doSaveCurrentWrapper]);

  // ── navigation & filter handlers ──
  const selectMedia = useCallback((mediaId: number) => {
    if (mediaId === selectedId) return;
    saveCurrentAsDraft(selectedId, boxesRef, deletedIdsRef, draftBoxRef, draftAnchorRef, pendingDraftPointRef, setDraftBox);
    setSelectedId(mediaId);
  }, [selectedId, saveCurrentAsDraft]);

  const handleStatusFilterChange = useCallback((next: "all" | "annotated" | "unannotated") => {
    if (next === statusFilter) return;
    saveCurrentAsDraft(selectedId, boxesRef, deletedIdsRef, draftBoxRef, draftAnchorRef, pendingDraftPointRef, setDraftBox);
    setStatusFilter(next);
    setSelectedId(null);
  }, [statusFilter, selectedId, saveCurrentAsDraft]);

  const handleClassFilterChange = useCallback((value: string) => {
    const newId = value ? Number(value) : null;
    if (newId === classFilterId) return;
    saveCurrentAsDraft(selectedId, boxesRef, deletedIdsRef, draftBoxRef, draftAnchorRef, pendingDraftPointRef, setDraftBox);
    setClassFilterId(newId);
    setSelectedId(null);
  }, [classFilterId, selectedId, saveCurrentAsDraft]);

  const handleDatasetBack = useCallback(() => {
    saveCurrentAsDraft(selectedId, boxesRef, deletedIdsRef, draftBoxRef, draftAnchorRef, pendingDraftPointRef, setDraftBox);
    if (draftsRef.current.size > 0) {
      setPendingNavAction(() => () => {
        draftsRef.current.clear();
        setDraftMediaIds(new Set());
        setSelectedDatasetId(null);
      });
      setUnsavedModalOpen(true);
      return;
    }
    setSelectedDatasetId(null);
  }, [selectedId, saveCurrentAsDraft]);

  // ── add class ──
  const handleCreateClass = useCallback(async () => {
    if (!selectedDatasetId || !newClassDisplayName.trim()) return;
    setAddingClass(true);
    setAddClassError("");
    try {
      const name = sanitizeClassName(newClassDisplayName);
      const created = await api.createDatasetClass(selectedDatasetId, { name, display_name: newClassDisplayName.trim() });
      const nextClasses = await api.datasetClasses(selectedDatasetId);
      setDatasetClasses(nextClasses);
      setActiveClassId(created.id);
      setNewClassDisplayName("");
      setAddClassOpen(false);
      setMessage("类别已创建，可以继续标注。");
    } catch (error) {
      setAddClassError(error instanceof Error ? error.message : "创建类别失败");
    } finally {
      setAddingClass(false);
    }
  }, [selectedDatasetId, newClassDisplayName]);

  // ── modals ──
  const handleDiscardAndNav = useCallback(() => {
    const action = pendingNavAction;
    setUnsavedModalOpen(false);
    setPendingNavAction(null);
    draftsRef.current.clear();
    setDraftMediaIds(new Set());
    action?.();
  }, [pendingNavAction]);

  const handleSaveAndNav = useCallback(async () => {
    const success = await doSaveAllDraftsWrapper();
    if (success) {
      const action = pendingNavAction;
      setUnsavedModalOpen(false);
      setPendingNavAction(null);
      action?.();
    }
  }, [doSaveAllDraftsWrapper, pendingNavAction]);

  // ── dataset selector view ──
  if (!selectedDatasetId) {
    return <DatasetSelector datasets={datasets} onSelectDataset={setSelectedDatasetId} />;
  }

  return (
    <section className="annotation-layout">
      <MediaSidebar
        selectedDatasetId={selectedDatasetId}
        selectedDataset={selectedDataset}
        totalAnnotated={totalAnnotated}
        datasetMediaTotal={datasetMediaTotal}
        currentDatasetStats={currentDatasetStats}
        datasetClasses={datasetClasses}
        statusFilter={statusFilter}
        classFilterId={classFilterId}
        loadingDataset={loadingDataset}
        loadingMoreMedia={loadingMoreMedia}
        hasMoreMedia={hasMoreMedia}
        imageItems={imageItems}
        selected={selected}
        draftMediaIds={draftMediaIds}
        mediaListRef={mediaListRef}
        onStatusFilterChange={handleStatusFilterChange}
        onClassFilterChange={handleClassFilterChange}
        onDatasetBack={handleDatasetBack}
        onMediaClick={selectMedia}
        onLoadMore={() => void loadMoreMedia()}
        onMediaListScroll={handleMediaListScroll}
      />

      <div className="annotator">
        <ClassManager
          datasetClasses={datasetClasses}
          activeClassId={activeClassId}
          selectedBoxClassId={selectedBox?.class_id}
          addClassOpen={addClassOpen}
          newClassDisplayName={newClassDisplayName}
          addClassError={addClassError}
          addingClass={addingClass}
          onClassChange={changeClass}
          onOpenAddClass={() => { setNewClassDisplayName(""); setAddClassError(""); setAddClassOpen(true); }}
          onCloseAddClass={() => setAddClassOpen(false)}
          onCreateClass={() => void handleCreateClass()}
          onNewClassDisplayNameChange={(v) => { setNewClassDisplayName(v); setAddClassError(""); }}
        />

        <AnnotationCanvas
          canvasDims={canvasDims}
          setCanvasDims={setCanvasDims}
          selectedDatasetId={selectedDatasetId}
          image={image}
          selected={selected}
          layout={layout}
          displayedBoxes={displayedBoxes}
          selectedBoxKey={selectedBoxKey}
          draftBox={draftBox}
          classById={classById}
          transformerRef={transformerRef}
          stageContainerRef={stageContainerRef}
          stageRef={stageRef}
          onMouseDown={startDraw}
          onMouseMove={updateDraw}
          onMouseUp={finishDraw}
          onBoxMouseDown={handleBoxMouseDown}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onTransformStart={handleTransformStart}
          onTransformEnd={handleTransformEnd}
        />

        <AnnotationToolbar
          message={message}
          saveStatus={saveStatus}
          historyLength={history.length}
          futureLength={future.length}
          hasSelectedBox={selectedBoxKey !== null}
          canSave={selected !== undefined}
          onUndo={undo}
          onRedo={redo}
          onDelete={deleteSelected}
          onSave={() => void saveAll()}
        />

        <AnnotationModals
          saveModalOpen={saveModalOpen}
          unsavedModalOpen={unsavedModalOpen}
          draftCount={draftsRef.current.size}
          currentHasDraft={selected ? draftsRef.current.has(selected.id) : false}
          onCloseSaveModal={() => setSaveModalOpen(false)}
          onSaveCurrent={() => { setSaveModalOpen(false); void doSaveCurrentWrapper(); }}
          onSaveAll={() => { setSaveModalOpen(false); void doSaveAllDraftsWrapper(); }}
          onCloseUnsavedModal={() => { setUnsavedModalOpen(false); setPendingNavAction(null); }}
          onDiscardAndNav={handleDiscardAndNav}
          onSaveAndNav={() => void handleSaveAndNav()}
        />
      </div>
    </section>
  );
}
