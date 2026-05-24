import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { Image as KonvaImage, Label as KonvaLabel, Layer, Rect, Stage, Tag as KonvaTag, Text, Transformer } from "react-konva";
import { Select } from "../../components/Select";
import { api } from "../../api";
import type { Dataset, DatasetDetail, MediaAsset, Summary } from "../../types";

type AnnotationBox = {
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

type AnnotationSnapshot = {
  boxes: AnnotationBox[];
  deletedIds: number[];
};

const MEDIA_PAGE_SIZE = 100;

function shortcutLabel(index: number): string | null {
  if (index < 9) return String(index + 1);          // 1-9
  if (index === 9) return "0";                       // 0
  if (index <= 35) return String.fromCharCode(87 + index); // a-z
  return null;
}

function truncateName(name: string, maxLen = 28): string {
  if (name.length <= maxLen) return name;
  const head = Math.floor(maxLen * 0.45);
  const tail = maxLen - head - 3;
  return name.slice(0, head) + "..." + name.slice(-tail);
}

function readableTextColor(hexColor: string): "#0f172a" | "#fff" {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return "#fff";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#0f172a" : "#fff";
}

function DatasetThumbs({ datasetId, sampleStats }: { datasetId: number; sampleStats: string }) {
  const [urls, setUrls] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let mediaCount = 0;
        try {
          const stats = JSON.parse(sampleStats || "{}");
          mediaCount = stats.media_count || 0;
        } catch { /* ignore */ }
        const limit = 4;
        const offset = mediaCount > limit
          ? Math.floor(Math.random() * (mediaCount - limit))
          : 0;
        const result = await api.datasetMedia(datasetId, { limit, offset });
        if (cancelled) return;
        setUrls(result.media.map((m) => api.mediaContentUrl(m.id)));
      } catch (e) {
        if (!cancelled) {
          console.error("DatasetThumbs load failed for dataset", datasetId, e);
          setUrls([]);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [datasetId, sampleStats]);

  return (
    <div className="dataset-select-thumbs">
      {urls && urls.length > 0 ? (
        urls.map((url, i) => (
          <img key={i} src={url} alt="" className="dataset-select-thumb" />
        ))
      ) : (
        <span className="dataset-select-thumb-placeholder">
          {urls === null ? "⏳" : "🖼"}
        </span>
      )}
    </div>
  );
}

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
  // ── dataset selection ──
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(initialDatasetId);

  const [datasetMedia, setDatasetMedia] = useState<DatasetDetail["media"]>([]);
  const [datasetMediaTotal, setDatasetMediaTotal] = useState(0);
  const [mediaPageOffset, setMediaPageOffset] = useState(0);
  const [currentDatasetStats, setCurrentDatasetStats] = useState<DatasetDetail["stats"] | null>(null);
  const [datasetClasses, setDatasetClasses] = useState<Summary["classes"]>([]);
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
  const [history, setHistory] = useState<AnnotationSnapshot[]>([]);
  const [future, setFuture] = useState<AnnotationSnapshot[]>([]);
  const [activeClassId, setActiveClassId] = useState<number>(0);
  const [message, setMessage] = useState("请先选择数据集，再开始标注。");
  const [canvasDims, setCanvasDims] = useState({ width: 860, height: 520 });
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<any>(null);
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [newClassDisplayName, setNewClassDisplayName] = useState("");
  const [addClassError, setAddClassError] = useState("");
  const [addingClass, setAddingClass] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [draftMediaIds, setDraftMediaIds] = useState<Set<number>>(new Set());
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false);
  const [pendingNavAction, setPendingNavAction] = useState<(() => void) | null>(null);

  useLayoutEffect(() => {
    const el = stageContainerRef.current;
    if (!el) return;
    const syncSize = () => {
      const width = Math.floor(el.clientWidth);
      const height = Math.floor(el.clientHeight);
      if (width <= 0 || height <= 0) return;
      setCanvasDims((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedDatasetId]);

  // ── derived ──
  const imageItems = useMemo(() => {
    return datasetMedia.filter((item) => item.media_type === "image");
  }, [datasetMedia]);
  const hasMoreMedia = datasetMedia.length < datasetMediaTotal;

  const classById = useMemo(() => new Map(datasetClasses.map((item) => [item.id, item])), [datasetClasses]);

  const selected = useMemo(
    () => imageItems.find((item) => item.id === selectedId) ?? imageItems[0],
    [imageItems, selectedId],
  );
  const image = useHtmlImage(selected?.id ?? null);
  const transformerRef = useRef<any>(null);

  // ── prefetch adjacent images for instant arrow-key navigation ──
  useEffect(() => {
    if (!selected) return;
    const idx = imageItems.findIndex((item) => item.id === selected.id);
    if (idx === -1) return;
    // 前后各预取 3 张
    for (let i = 1; i <= 3; i++) {
      if (idx - i >= 0) prefetchImage(imageItems[idx - i].id);
      if (idx + i < imageItems.length) prefetchImage(imageItems[idx + i].id);
    }
  }, [selected, imageItems]);

  // ── load dataset media ──
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

  const resetDraftState = () => {
    draftBoxRef.current = null;
    draftAnchorRef.current = null;
    pendingDraftPointRef.current = null;
    setDraftBox(null);
  };

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
      setHistory([]);
      setFuture([]);
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
    setHistory([]);
    setFuture([]);
    draftsRef.current.clear();
    setDraftMediaIds(new Set());
    setLoadingDataset(true);
    setLoadingMoreMedia(false);
    setMessage("\u6b63\u5728\u52a0\u8f7d\u6570\u636e\u96c6...");

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
        if (desiredLoaded) {
          setSelectedId(desiredLoaded.id);
        } else if (firstImage) {
          setSelectedId(firstImage.id);
        } else {
          setSelectedId(null);
        }
        setMessage(`\u5df2\u52a0\u8f7d ${nextMedia.length}/${result.total} \u4e2a\u7d20\u6750`);
      } catch (err) {
        if (!cancelled && requestSeq === mediaRequestSeqRef.current) {
          setMessage(err instanceof Error ? err.message : "\u52a0\u8f7d\u6570\u636e\u96c6\u5931\u8d25");
          setLoadingDataset(false);
        }
      }
    };

    void loadFirstPage();
    return () => {
      cancelled = true;
    };
  }, [selectedDatasetId, mediaQueryParams, initialMediaId]);

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
      setMessage(error instanceof Error ? error.message : "\u52a0\u8f7d\u66f4\u591a\u7d20\u6750\u5931\u8d25");
    } finally {
      if (requestSeq === mediaRequestSeqRef.current) setLoadingMoreMedia(false);
    }
  }, [hasMoreMedia, loadingDataset, loadingMoreMedia, mediaPageOffset, mediaQueryParams, selectedDatasetId]);

  const handleMediaListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) {
      void loadMoreMedia();
    }
  }, [loadMoreMedia]);

  const targetMediaConsumed = useRef(false);
  useEffect(() => {
    if (initialMediaId !== null && !loadingDataset && datasetMedia.length > 0 && !targetMediaConsumed.current) {
      if (datasetMedia.some((m) => m.id === initialMediaId)) {
        targetMediaConsumed.current = true;
        setSelectedId(initialMediaId);
        onTargetConsumed();
      }
    }
  }, [initialMediaId, datasetMedia, loadingDataset, onTargetConsumed]);

    // ── keep activeClassId in sync with dataset classes ──
  useEffect(() => {
    if (datasetClasses.length === 0) {
      setActiveClassId(0);
    } else if (!datasetClasses.find((c) => c.id === activeClassId)) {
      setActiveClassId(datasetClasses[0].id);
    }
  }, [datasetClasses, activeClassId]);

  // ── load annotations for selected image ──
  useEffect(() => {
    if (!selected) return;
    // save current position as we navigate
    if (selectedDatasetId) {
      localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selected.id));
    }
    const draft = draftsRef.current.get(selected.id);
    if (draft) {
      setBoxes(draft.boxes.map(cloneBox));
      setDeletedIds([...draft.deletedIds]);
      setSelectedBoxKey(null);
      setHistory([]);
      setFuture([]);
      setSaveStatus("idle");
      setMessage("已加载草稿标注，可以继续编辑或保存。");
      return;
    }
    let cancelled = false;
    setMessage("\u6b63\u5728\u52a0\u8f7d\u6807\u6ce8...");
    api
      .annotationsForMedia(selected.id, selectedDatasetId ?? undefined)
      .then((result) => {
        if (!cancelled) {
          setBoxes(result.annotations.map(mapAnnotationBox));
          draftBoxRef.current = null;
          draftAnchorRef.current = null;
          pendingDraftPointRef.current = null;
          setDraftBox(null);
          setDeletedIds([]);
          setSelectedBoxKey(null);
          setHistory([]);
          setFuture([]);
          setSaveStatus("idle");
          setMessage("\u5df2\u52a0\u8f7d\u6807\u6ce8\uff0c\u53ef\u4ee5\u7ee7\u7eed\u8865\u5145\u6216\u4fee\u8ba2\u3002");
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "\u6807\u6ce8\u52a0\u8f7d\u5931\u8d25");
      });
    return () => {
      cancelled = true;
    };
  }, [selected, selectedDatasetId]);

  const layout = imageLayout(selected as unknown as MediaAsset | undefined, canvasDims.width, canvasDims.height);
  const selectedBox = boxes.find((box) => box.local_id === selectedBoxKey);
  const displayedBoxes = useMemo(() => (draftBox ? [...boxes, draftBox] : boxes), [boxes, draftBox]);
  const hasUnsavedChanges = boxes.some((box) => !box.id || box.dirty) || deletedIds.length > 0 || draftBox !== null;
  const hasUnsavedChangesRef = useRef(false);
  hasUnsavedChangesRef.current = hasUnsavedChanges;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const deletedIdsRef = useRef(deletedIds);
  deletedIdsRef.current = deletedIds;
  const draftsRef = useRef<Map<number, { boxes: AnnotationBox[]; deletedIds: number[] }>>(new Map());

  useEffect(() => {
    return () => {
      if (draftFrameRef.current !== null) {
        window.cancelAnimationFrame(draftFrameRef.current);
      }
      draftBoxRef.current = null;
      draftAnchorRef.current = null;
      pendingDraftPointRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (draftsRef.current.size > 0 || hasUnsavedChangesRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const stage = transformer.getStage();
    const node = selectedBoxKey ? stage?.findOne(`#box-${selectedBoxKey}`) : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedBoxKey, boxes, layout]);

  // ── keyboard shortcut refs (declared early, assigned after function definitions) ──
  const imageItemsRef = useRef(imageItems);
  imageItemsRef.current = imageItems;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedBoxKeyRef = useRef(selectedBoxKey);
  selectedBoxKeyRef.current = selectedBoxKey;
  const changeClassRef = useRef<(classId: number) => void>(null!);
  const undoRef = useRef<() => void>(null!);
  const redoRef = useRef<() => void>(null!);
  const deleteSelectedRef = useRef<() => void>(null!);
  const selectMediaRef = useRef<(mediaId: number) => void>(null!);
  const classesRef = useRef(datasetClasses);
  classesRef.current = datasetClasses;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const currentClasses = classesRef.current;
      // number/letter keys for class selection: 1-9 → class 1-9, 0 → class 10, a-z → class 11-36
      const key = event.key;
      let classIndex = -1;
      if (key >= "1" && key <= "9") classIndex = key.charCodeAt(0) - 49;       // "1"=49 → index 0
      else if (key === "0") classIndex = 9;                                      // "0" → index 9
      else if (key >= "a" && key <= "z") classIndex = key.charCodeAt(0) - 87;   // "a"=97 → index 10
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

  const snapshot = (): AnnotationSnapshot => ({
    boxes: boxes.map(cloneBox),
    deletedIds: [...deletedIds],
  });

  const commitHistory = () => {
    setHistory((current) => [...current, snapshot()].slice(-40));
    setFuture([]);
  };

  const restoreSnapshot = (next: AnnotationSnapshot) => {
    setBoxes(next.boxes.map(cloneBox));
    setDeletedIds([...next.deletedIds]);
    draftBoxRef.current = null;
    draftAnchorRef.current = null;
    pendingDraftPointRef.current = null;
    setDraftBox(null);
    setSelectedBoxKey(null);
  };

  const saveCurrentAsDraft = () => {
    const currentId = selectedIdRef.current;
    if (!currentId) return;
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
    draftsRef.current.set(currentId, {
      boxes: currentBoxes.map(cloneBox),
      deletedIds: [...currentDeleted],
    });
    setDraftMediaIds(new Set(draftsRef.current.keys()));
  };

  const selectMedia = (mediaId: number) => {
    if (mediaId === selectedIdRef.current) return;
    saveCurrentAsDraft();
    setSelectedId(mediaId);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current[current.length - 1];
      if (!previous) return current;
      setFuture((items) => [snapshot(), ...items].slice(0, 40));
      restoreSnapshot(previous);
      setMessage("\u5df2\u64a4\u9500\u4e0a\u4e00\u6b65\u7f16\u8f91\u3002");
      return current.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((current) => {
      const next = current[0];
      if (!next) return current;
      setHistory((items) => [...items, snapshot()].slice(-40));
      restoreSnapshot(next);
      setMessage("\u5df2\u91cd\u505a\u4e0a\u4e00\u6b65\u7f16\u8f91\u3002");
      return current.slice(1);
    });
  };

  const startDraw = (event: any) => {
    if (!selected) return;
    if (!activeClassId) {
      setMessage("当前数据集还没有类别，请先点击上方“新增”创建类别。");
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
  };

  const updateDraw = (event: any) => {
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
  };

  const finishDraw = () => {
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
      setMessage("\u6846\u592a\u5c0f\uff0c\u5df2\u5ffd\u7565\u3002");
      return;
    }
    commitHistory();
    setBoxes((current) => [...current, finalDraft]);
    setSelectedBoxKey(finalDraft.local_id);
    setDraftBox(null);
    setMessage("\u65b0\u6846\u5df2\u52a0\u5165\uff0c\u70b9\u51fb\u4fdd\u5b58\u5199\u5165\u6570\u636e\u5e93\u3002");
  };

  const updateBox = (localId: string, patch: Partial<AnnotationBox>) => {
    setBoxes((current) =>
      current.map((box) => (box.local_id === localId ? clampBox({ ...box, ...patch, dirty: Boolean(box.id) || box.dirty }) : box)),
    );
  };

  const deleteSelected = () => {
    if (!selectedBoxKey) return;
    const box = boxes.find((item) => item.local_id === selectedBoxKey);
    if (!box) return;
    commitHistory();
    setBoxes((current) => current.filter((item) => item.local_id !== selectedBoxKey));
    if (box.id) {
      setDeletedIds((current) => [...new Set([...current, box.id as number])]);
    }
    setSelectedBoxKey(null);
    setMessage(box.id ? "\u5df2\u6807\u8bb0\u5220\u9664\uff0c\u4fdd\u5b58\u540e\u4f1a\u4ece SQLite \u79fb\u9664\u3002" : "\u5df2\u5220\u9664\u672a\u4fdd\u5b58\u7684\u6807\u6ce8\u6846\u3002");
  };

  const changeClass = (classId: number) => {
    setActiveClassId(classId);
    if (!selectedBoxKey) return;
    commitHistory();
    updateBox(selectedBoxKey, { class_id: classId });
    setMessage("\u5df2\u66f4\u65b0\u6240\u9009\u6807\u6ce8\u7c7b\u522b\u3002");
  };

  // wire keyboard shortcut refs after function definitions
  changeClassRef.current = changeClass;
  undoRef.current = undo;
  redoRef.current = redo;
  deleteSelectedRef.current = deleteSelected;
  selectMediaRef.current = selectMedia;

  const handleStatusFilterChange = (next: "all" | "annotated" | "unannotated") => {
    if (next === statusFilter) return;
    saveCurrentAsDraft();
    setStatusFilter(next);
    setSelectedId(null);
  };

  const handleClassFilterChange = (value: string) => {
    const newId = value ? Number(value) : null;
    if (newId === classFilterId) return;
    saveCurrentAsDraft();
    setClassFilterId(newId);
    setSelectedId(null);
  };

  const handleDatasetBack = () => {
    saveCurrentAsDraft();
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
  };

  const handleCreateClass = async () => {
    if (!selectedDatasetId || !newClassDisplayName.trim()) return;
    setAddingClass(true);
    setAddClassError("");
    try {
      let name = newClassDisplayName.trim().toLowerCase().replace(/\s+/g, "_");
      name = name.replace(/[^a-z0-9_.-]+/g, "_").replace(/^_|_$/g, "").replace(/_{2,}/g, "_");
      if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        name = "class_" + Date.now();
      }
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
  };

  const handleDragStart = (box: AnnotationBox, event: any) => {
    event.cancelBubble = true;
    commitHistory();
    setSelectedBoxKey(box.local_id);
  };

  const handleDragEnd = (box: AnnotationBox, event: any) => {
    const rect = event.target;
    const next = pixelsToBox(rect.x(), rect.y(), rect.width(), rect.height(), layout);
    updateBox(box.local_id, next);
    setMessage("\u6807\u6ce8\u6846\u4f4d\u7f6e\u5df2\u66f4\u65b0\u3002");
  };

  const handleTransformStart = (box: AnnotationBox, event: any) => {
    event.cancelBubble = true;
    commitHistory();
    setSelectedBoxKey(box.local_id);
  };

  const handleTransformEnd = (box: AnnotationBox, event: any) => {
    const node = event.target;
    const next = pixelsToBox(
      node.x(),
      node.y(),
      Math.max(node.width() * node.scaleX(), 4),
      Math.max(node.height() * node.scaleY(), 4),
      layout,
    );
    node.scaleX(1);
    node.scaleY(1);
    updateBox(box.local_id, next);
    setMessage("\u6807\u6ce8\u6846\u5c3a\u5bf8\u5df2\u66f4\u65b0\u3002");
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

  const doSaveCurrent = async (): Promise<boolean> => {
    if (!selected || !selectedDatasetId) return false;
    const unsaved = boxes.filter((box) => !box.id);
    const changed = boxes.filter((box) => box.id && box.dirty);
    const totalChanges = unsaved.length + changed.length + deletedIds.length;
    if (totalChanges === 0) {
      draftsRef.current.delete(selected.id);
      setDraftMediaIds(new Set(draftsRef.current.keys()));
      setMessage("\u6ca1\u6709\u6807\u6ce8\u6539\u52a8\u9700\u8981\u4fdd\u5b58\u3002");
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
        }
      }
      for (const [mediaId, draft] of draftsRef.current) {
        if (selected && mediaId === selected.id) continue;
        const draftUnsaved = draft.boxes.filter((b) => !b.id);
        const draftChanged = draft.boxes.filter((b) => b.id && b.dirty);
        const draftChanges = draftUnsaved.length + draftChanged.length + draft.deletedIds.length;
        if (draftChanges > 0) {
          setMessage(`\u6b63\u5728\u4fdd\u5b58\u56fe\u7247 #${mediaId} \u7684\u8349\u7a3f...`);
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
      localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selected?.id));
      setSaveStatus("saved");
      setMessage(`\u5df2\u4fdd\u5b58\u5168\u90e8 ${totalSaved} \u4e2a\u6807\u6ce8\u6539\u52a8\u3002`);
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "\u4fdd\u5b58\u5931\u8d25");
      return false;
    }
  };

  // ── dataset selector view ──
  if (!selectedDatasetId) {
    return (
      <section className="stack">
        <div className="panel flush">
          <h2>选择数据集</h2>
          <p className="helper-text">请选择一个数据集开始标注。数据集在「数据集管理」页面创建。</p>
        </div>
        <div className="dataset-select-grid">
          {datasets.length === 0 ? (
            <EmptyLine text="还没有数据集，请先在「数据集管理」中创建或导入。" />
          ) : (
            datasets.map((ds) => (
                <button
                  key={ds.id}
                  className="dataset-select-card"
                    onClick={() => setSelectedDatasetId(ds.id)}
                >
                  <DatasetThumbs datasetId={ds.id} sampleStats={ds.sample_stats} />
                  <div className="dataset-select-info">
                    <strong>{ds.name}</strong>
                    <span>{datasetTypeName(ds.dataset_type)}</span>
                    <span className="dataset-select-meta">{datasetStats(ds)}</span>
                  </div>
                </button>
              ))
          )}
        </div>
      </section>
    );
  }

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId);
  const totalAnnotated = currentDatasetStats?.annotated_media ?? datasetMedia.filter((m) => m.annotation_count > 0).length;

  return (
    <section className="annotation-layout">
      <aside className="annotation-sidebar">
        <div className="sidebar-header">
          <button className="back-link" onClick={handleDatasetBack} title="返回选择数据集">
            ← 切换
          </button>
          <span className="sidebar-dataset-name" title={selectedDataset?.name}>{selectedDataset?.name ?? `#${selectedDatasetId}`}</span>
          <span className="sidebar-progress">{totalAnnotated}/{currentDatasetStats?.total_media ?? datasetMedia.length}</span>
        </div>

        <div className="sidebar-filter-row">
          <div className="filter-btn-group">
            <button className={`filter-btn ${statusFilter === "all" ? "active" : ""}`} onClick={() => handleStatusFilterChange("all")}>全部</button>
            <button className={`filter-btn ${statusFilter === "annotated" ? "active" : ""}`} onClick={() => handleStatusFilterChange("annotated")}>已标</button>
            <button className={`filter-btn ${statusFilter === "unannotated" ? "active" : ""}`} onClick={() => handleStatusFilterChange("unannotated")}>未标</button>
          </div>
          {datasetClasses.length > 0 ? (
            <Select
              className="filter-select-compact"
              options={[{ value: "", label: "全部类别" }, ...datasetClasses.map((cls) => ({ value: String(cls.id), label: cls.display_name }))]}
              value={String(classFilterId ?? "")}
              onChange={handleClassFilterChange}
            />
          ) : null}
        </div>

        <div className="media-list" ref={mediaListRef} onScroll={handleMediaListScroll}>
          {loadingDataset ? (
            <EmptyLine text="加载中..." />
          ) : imageItems.length === 0 ? (
            <EmptyLine text="无匹配图片" />
          ) : (
            <>
              {imageItems.map((item) => (
                <button
                  key={item.id}
                  className={selected?.id === item.id ? "media-button active" : "media-button"}
                  onClick={() => selectMedia(item.id)}
                  title={item.original_name}
                >
                  <span className="media-name">
                    <span className={`status-dot ${draftMediaIds.has(item.id) ? "draft" : item.annotation_count > 0 ? "saved" : "empty"}`} />
                    <span className="media-id">{item.id}</span> {truncateName(item.original_name)}
                  </span>
                  <span className="media-meta">
                    {item.annotation_count > 0 ? `${item.annotation_count} boxes` : ""}
                  </span>
                </button>
              ))}
              {loadingMoreMedia ? <EmptyLine text="Loading more..." /> : null}
              {!loadingMoreMedia && hasMoreMedia ? (
                <button className="media-button" onClick={() => void loadMoreMedia()}>
                  <span className="media-name">Load more</span>
                  <span className="media-meta">{datasetMedia.length}/{datasetMediaTotal}</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div className="annotator">
        <div className="class-tags">
          {datasetClasses.map((item, index) => {
            const isActive = item.id === (selectedBox?.class_id ?? activeClassId);
            const color = item.color ?? "#2979ff";
            const shortcut = shortcutLabel(index);
            return (
              <button
                key={item.id}
                className={`class-tag ${isActive ? "active" : ""}`}
                style={{
                  "--tag-color": color,
                  "--tag-border": color + "33",
                  "--tag-bg": color + "14",
                  "--tag-border-hover": color + "66",
                  "--tag-bg-hover": color + "22",
                } as React.CSSProperties}
                onClick={() => changeClass(item.id)}
                title={shortcut ? `${item.display_name} (${shortcut})` : item.display_name}
              >
                {shortcut ? <span className="class-tag-num">{shortcut}</span> : null}
                {item.display_name}
              </button>
            );
          })}
          <button
            className="class-tag class-tag-add"
            onClick={() => {
              setNewClassDisplayName("");
              setAddClassError("");
              setAddClassOpen(true);
            }}
            title="新增类别"
          >
            <Plus size={13} />
            新增
          </button>
        </div>

        <div className="stage-container" ref={stageContainerRef}>
          <Stage
            ref={stageRef}
            width={canvasDims.width}
            height={canvasDims.height}
            onMouseDown={startDraw}
            onMouseMove={updateDraw}
            onMouseUp={finishDraw}
          >
            <Layer>
            <Rect name="canvas-bg" x={0} y={0} width={canvasDims.width} height={canvasDims.height} fill="#f8fafc" />
            {image && selected ? (
              <KonvaImage name="image" image={image} x={layout.x} y={layout.y} width={layout.width} height={layout.height} />
            ) : (
              <Text x={canvasDims.width / 2 - 100} y={canvasDims.height / 2 - 15} text={selected ? "正在加载图片" : "选择图片后开始标注"} fontSize={20} fill="#334155" />
            )}
            {displayedBoxes.map((box) => {
              const classItem = classById.get(box.class_id);
              const color = classItem?.color ?? "#2979ff";
              const labelTextColor = readableTextColor(color);
              const displayName = classItem?.display_name ?? "";
              const px = layout.x + box.x * layout.width;
              const py = layout.y + box.y * layout.height;
              const pw = box.width * layout.width;
              return (
                <Fragment key={box.local_id}>
                  <Rect
                    id={`box-${box.local_id}`}
                    name="annotation-box"
                    x={px}
                    y={py}
                    width={pw}
                    height={box.height * layout.height}
                    stroke={color}
                    strokeWidth={box.local_id === selectedBoxKey ? 4 : 3}
                    perfectDrawEnabled={false}
                    shadowForStrokeEnabled={false}
                    draggable={!draftBox}
                    dash={box.id ? undefined : [8, 6]}
                    onMouseDown={(event) => {
                      event.cancelBubble = true;
                      setSelectedBoxKey(box.local_id);
                    }}
                    onDragStart={(event) => handleDragStart(box, event)}
                    onDragEnd={(event) => handleDragEnd(box, event)}
                    onTransformStart={(event) => handleTransformStart(box, event)}
                    onTransformEnd={(event) => handleTransformEnd(box, event)}
                  />
                  {displayName ? (
                    <KonvaLabel x={px} y={py - 22}>
                      <KonvaTag fill={color} cornerRadius={2} />
                      <Text text={displayName} fontSize={13} fontStyle="bold" fill={labelTextColor} padding={3} />
                    </KonvaLabel>
                  ) : null}
                </Fragment>
              );
            })}
            <Transformer
              ref={transformerRef}
              rotateEnabled={false}
              enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]}
              borderStroke="#0f172a"
              anchorStroke="#0f172a"
              anchorFill="#ffffff"
              anchorSize={8}
            />
            </Layer>
          </Stage>
        </div>

        <div className="canvas-actions-row">
          <span className="inline-status">
            {saveStatus === "saving" ? "⏳ " : saveStatus === "saved" ? "✓ " : saveStatus === "error" ? "⚠ " : ""}
            {message}
          </span>
          <div className="canvas-actions">
            <button title="撤销 Ctrl+Z" onClick={undo} disabled={history.length === 0}>
              <RotateCcw size={15} />
              <span>撤销</span>
            </button>
            <button title="重做 Ctrl+Y" onClick={redo} disabled={future.length === 0}>
              <RotateCw size={15} />
              <span>重做</span>
            </button>
            <button title="删除标注 Delete" onClick={deleteSelected} disabled={!selectedBoxKey}>
              <Trash2 size={15} />
              <span>删除</span>
            </button>
            <button className="save-btn" title="保存标注" onClick={() => void saveAll()} disabled={!selected}>
              <CheckCircle2 size={15} />
              <span>保存</span>
            </button>
          </div>
        </div>

        {addClassOpen ? (
          <div className="modal-overlay" onClick={() => setAddClassOpen(false)}>
            <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
              <h3>新增标注类别</h3>
              <input
                value={newClassDisplayName}
                onChange={(event) => {
                  setNewClassDisplayName(event.target.value);
                  setAddClassError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !addingClass) void handleCreateClass();
                }}
                placeholder="类别名称，例如：野猫"
                autoFocus
                disabled={addingClass}
              />
              {addClassError ? <p className="modal-error">{addClassError}</p> : null}
              <div className="modal-actions">
                <button onClick={() => setAddClassOpen(false)} disabled={addingClass}>取消</button>
                <button className="primary" onClick={() => void handleCreateClass()} disabled={addingClass || !newClassDisplayName.trim()}>
                  {addingClass ? "创建中..." : "确定"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {saveModalOpen ? (
          <div className="modal-overlay" onClick={() => setSaveModalOpen(false)}>
            <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
              <h3>保存标注</h3>
              <p className="modal-desc">
                当前有 {draftsRef.current.size - (draftsRef.current.has(selected.id) ? 1 : 0)} 张其他图片的标注草稿未保存。
              </p>
              <div className="modal-actions">
                <button onClick={() => setSaveModalOpen(false)}>取消</button>
                <button onClick={() => { setSaveModalOpen(false); void doSaveCurrent(); }}>
                  仅保存当前图片
                </button>
                <button className="primary" onClick={() => { setSaveModalOpen(false); void doSaveAllDrafts(); }}>
                  保存全部草稿
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {unsavedModalOpen ? (
          <div className="modal-overlay">
            <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
              <h3>未保存的草稿</h3>
              <p className="modal-desc">
                当前有 {draftsRef.current.size} 张图片的标注草稿未保存，离开后草稿会丢失。
              </p>
              <div className="modal-actions">
                <button onClick={() => { setUnsavedModalOpen(false); setPendingNavAction(null); }}>取消</button>
                <button onClick={() => {
                  const action = pendingNavAction;
                  setUnsavedModalOpen(false);
                  setPendingNavAction(null);
                  draftsRef.current.clear();
                  setDraftMediaIds(new Set());
                  action?.();
                }}>
                  不保存
                </button>
                <button className="primary" onClick={() => void (async () => {
                  const success = await doSaveAllDrafts();
                  if (success) {
                    const action = pendingNavAction;
                    setUnsavedModalOpen(false);
                    setPendingNavAction(null);
                    action?.();
                  }
                })()}>
                  保存全部并返回
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function makeLocalId() {
  return `local-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function cloneBox(box: AnnotationBox): AnnotationBox {
  return { ...box };
}

function mapAnnotationBox(item: {
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

function annotationPayload(box: AnnotationBox) {
  return {
    class_id: box.class_id,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    review_status: box.review_status,
  };
}
// Image loading cache and low-priority neighbor prefetch.
const imageCache = new Map<number, HTMLImageElement>();
const imageRequests = new Map<number, Promise<HTMLImageElement>>();
const prefetchQueue = new Map<number, () => Promise<void>>();
const MAX_CACHED_IMAGES = 16;
const MAX_PREFETCHING_IMAGES = 2;
let activePrefetches = 0;
let prefetchTimer: number | null = null;

function cacheImage(mediaId: number, image: HTMLImageElement): void {
  if (imageCache.has(mediaId)) imageCache.delete(mediaId);
  while (imageCache.size >= MAX_CACHED_IMAGES) {
    const firstKey = imageCache.keys().next().value;
    if (firstKey === undefined) break;
    imageCache.delete(firstKey);
  }
  imageCache.set(mediaId, image);
}

function loadImage(mediaId: number): Promise<HTMLImageElement> {
  const cached = imageCache.get(mediaId);
  if (cached) {
    cacheImage(mediaId, cached);
    return Promise.resolve(cached);
  }

  const existingRequest = imageRequests.get(mediaId);
  if (existingRequest) return existingRequest;

  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new window.Image();
    img.decoding = "async";
    img.onload = () => {
      cacheImage(mediaId, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Image load failed for media ${mediaId}`));
    img.src = api.mediaContentUrl(mediaId);
  }).finally(() => {
    imageRequests.delete(mediaId);
  });

  imageRequests.set(mediaId, request);
  return request;
}

function schedulePrefetchQueue(): void {
  if (prefetchTimer !== null) return;
  const run = () => {
    prefetchTimer = null;
    while (activePrefetches < MAX_PREFETCHING_IMAGES && prefetchQueue.size > 0) {
      const [mediaId, task] = prefetchQueue.entries().next().value as [number, () => Promise<void>];
      prefetchQueue.delete(mediaId);
      activePrefetches += 1;
      task()
        .catch(() => {
          // Prefetch is opportunistic; failed images will be retried when selected.
        })
        .finally(() => {
          activePrefetches -= 1;
          schedulePrefetchQueue();
        });
    }
  };

  const requestIdle = (window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;
  prefetchTimer = requestIdle ? requestIdle(run, { timeout: 300 }) : window.setTimeout(run, 120);
}

function prefetchImage(mediaId: number): void {
  if (imageCache.has(mediaId) || imageRequests.has(mediaId) || prefetchQueue.has(mediaId)) return;
  prefetchQueue.set(mediaId, () => loadImage(mediaId).then(() => undefined));
  schedulePrefetchQueue();
}

function useHtmlImage(mediaId: number | null) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (mediaId === null) {
      setImage(null);
      return;
    }

    const cached = imageCache.get(mediaId);
    if (cached) {
      cacheImage(mediaId, cached);
      setImage(cached);
      return;
    }

    let cancelled = false;
    loadImage(mediaId)
      .then((next) => {
        if (!cancelled) setImage(next);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load image for media", mediaId, err);
      });

    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  return image;
}

function imageLayout(media: MediaAsset | undefined, canvasWidth = 860, canvasHeight = 520) {
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

function pointInsideImage(point: { x: number; y: number }, layout: ReturnType<typeof imageLayout>) {
  return point.x >= layout.x && point.x <= layout.x + layout.width && point.y >= layout.y && point.y <= layout.y + layout.height;
}

function normalizePoint(point: { x: number; y: number }, layout: ReturnType<typeof imageLayout>) {
  return {
    x: clamp((point.x - layout.x) / layout.width, 0, 1),
    y: clamp((point.y - layout.y) / layout.height, 0, 1),
  };
}

function resizeDraftBox(
  draftBox: AnnotationBox,
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  layout: ReturnType<typeof imageLayout>,
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

function pixelsToBox(x: number, y: number, width: number, height: number, layout: ReturnType<typeof imageLayout>) {
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

function clampBox<T extends AnnotationBox>(box: T): T {
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

function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

function datasetStats(dataset: Dataset) {
  try {
    const stats = JSON.parse(dataset.sample_stats || "{}") as {
      annotation_status?: string;
      media_count?: number;
      annotation_count?: number;
    };
    const status = stats.annotation_status === "unlabeled" ? "未标注" : stats.annotation_status === "labeled" ? "已标注" : `v${dataset.version}`;
    if (stats.media_count !== undefined) {
      return `${status} · ${stats.media_count} 素材 · ${stats.annotation_count ?? 0} 框`;
    }
    return status;
  } catch {
    return `v${dataset.version}`;
  }
}

function datasetTypeName(type: Dataset["dataset_type"]) {
  return {
    public: "公开数据集",
    user: "用户数据集",
    fusion: "融合数据集",
  }[type];
}

