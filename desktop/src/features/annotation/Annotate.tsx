import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { AssistedAnnotationPrediction, AssistedAnnotationSettings, Dataset, DatasetDetail, Summary } from "../../types";
import { cloneBox, makeLocalId, mapAnnotationBox } from "./annotationBoxUtils";
import type { AnnotationBox, AnnotationSnapshot } from "./annotationTypes";
import { AnnotationCanvas } from "./components/AnnotationCanvas";
import { AnnotationModals } from "./components/AnnotationModals";
import { AnnotationSidebar } from "./components/AnnotationSidebar";
import { DatasetPicker } from "./components/DatasetPicker";
import { useAnnotationSave } from "./hooks/useAnnotationSave";
import { useAnnotationShortcuts } from "./hooks/useAnnotationShortcuts";
import { prefetchImage, useHtmlImage } from "./hooks/useHtmlImage";
import { useResizableCanvas } from "./hooks/useResizableCanvas";
import { clampBox, imageLayout, normalizePoint, pixelsToBox, pointInsideImage, resizeDraftBox } from "./imageGeometry";

const MEDIA_PAGE_SIZE = 100;

function cleanPredictionClassName(value: string) {
  return value.trim() || "未命名类别";
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
  const previousDatasetIdRef = useRef<number | null>(null);

  // ── filters ──
  const [statusFilter, setStatusFilter] = useState<"all" | "annotated" | "unannotated">("all");
  const [classFilterId, setClassFilterId] = useState<number | null>(null);
  const [randomOrderEnabled, setRandomOrderEnabled] = useState(false);
  const [randomOrderSeed, setRandomOrderSeed] = useState(() => Math.floor(Math.random() * 2147483647));

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
  const stageRef = useRef<any>(null);
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [newClassDisplayName, setNewClassDisplayName] = useState("");
  const [addClassError, setAddClassError] = useState("");
  const [addingClass, setAddingClass] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [draftMediaIds, setDraftMediaIds] = useState<Set<number>>(new Set());
  const [predictedMediaIds, setPredictedMediaIds] = useState<Set<number>>(new Set());
  const [predictionEmptyMediaIds, setPredictionEmptyMediaIds] = useState<Set<number>>(new Set());
  const [loadedAnnotationMediaId, setLoadedAnnotationMediaId] = useState<number | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false);
  const [pendingNavAction, setPendingNavAction] = useState<(() => void) | null>(null);
  const { canvasDims, stageContainerRef } = useResizableCanvas(selectedDatasetId);

  // ── derived ──
  const imageItems = useMemo(() => {
    return datasetMedia.filter((item) => item.media_type === "image");
  }, [datasetMedia]);
  const orderedDatasetClasses = useMemo(() => {
    const classCounts = currentDatasetStats?.class_counts ?? {};
    return [...datasetClasses].sort((a, b) => {
      const countDiff = (classCounts[b.display_name] ?? 0) - (classCounts[a.display_name] ?? 0);
      return countDiff !== 0 ? countDiff : a.sort_order - b.sort_order;
    });
  }, [currentDatasetStats, datasetClasses]);
  const hasMoreMedia = datasetMedia.length < datasetMediaTotal;

  const selected = useMemo(
    () => imageItems.find((item) => item.id === selectedId) ?? imageItems[0],
    [imageItems, selectedId],
  );
  const image = useHtmlImage(selected?.id ?? null);
  const transformerRef = useRef<any>(null);
  const [assistedActive, setAssistedActive] = useState(false);
  const [assistedLoading, setAssistedLoading] = useState(false);
  const [assistedSettings, setAssistedSettings] = useState<AssistedAnnotationSettings | null>(null);
  const assistedPredictedMediaIdsRef = useRef<Set<number>>(new Set());
  const [predictionFailedMediaIds, setPredictionFailedMediaIds] = useState<Set<number>>(new Set());
  const provisionalClassIdsRef = useRef<Map<string, number>>(new Map());
  const nextProvisionalClassIdRef = useRef(-1);

  const imageItemsRef = useRef(imageItems);
  imageItemsRef.current = imageItems;
  const predictionInFlightRef = useRef<Set<number>>(new Set());

  const provisionalClassId = useCallback((className: string) => {
    const key = cleanPredictionClassName(className).toLowerCase();
    const existing = provisionalClassIdsRef.current.get(key);
    if (existing) return existing;
    const next = nextProvisionalClassIdRef.current;
    nextProvisionalClassIdRef.current -= 1;
    provisionalClassIdsRef.current.set(key, next);
    return next;
  }, []);

  const predictionBoxes = useCallback(
    (predictions: AssistedAnnotationPrediction[]): AnnotationBox[] =>
      predictions
        .filter((prediction) => prediction.width > 0 && prediction.height > 0)
        .map((prediction) => {
          const className = cleanPredictionClassName(prediction.class_name);
          return clampBox({
            local_id: makeLocalId(),
            class_id: prediction.class_id ?? provisionalClassId(className),
            predicted_class_name: prediction.class_id ? undefined : className,
            confidence: prediction.confidence,
            source: "assistant",
            x: prediction.x,
            y: prediction.y,
            width: prediction.width,
            height: prediction.height,
            review_status: "draft",
          });
        }),
    [provisionalClassId],
  );

  useEffect(() => {
    assistedPredictedMediaIdsRef.current.clear();
    predictionInFlightRef.current.clear();
    setPredictionFailedMediaIds(new Set());
    setPredictionEmptyMediaIds(new Set());
    setAssistedActive(false);
    setAssistedSettings(null);
    setAssistedLoading(Boolean(selectedDatasetId));
    if (!selectedDatasetId) {
      void api.stopAssistedAnnotation();
      return;
    }
    setMessage("正在加载辅助标注模型...");

    let cancelled = false;
    api
      .startAssistedAnnotation({ dataset_id: selectedDatasetId })
      .then((status) => {
        if (cancelled) return;
        setAssistedSettings(status.settings ?? null);
        const isActive = Boolean(status.enabled && status.loaded);
        setAssistedActive(isActive);
        setAssistedLoading(false);
        if (isActive) {
          setMessage("辅助标注模型已加载，将在浏览图片时生成预标注草稿。");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setAssistedActive(false);
        setAssistedLoading(false);
        setMessage(error instanceof Error ? error.message : "辅助标注模型加载失败");
      });

    return () => {
      cancelled = true;
      assistedPredictedMediaIdsRef.current.clear();
      setAssistedLoading(false);
      setAssistedActive(false);
      void api.stopAssistedAnnotation();
    };
  }, [selectedDatasetId]);

  // ── prefetch adjacent images for instant arrow-key navigation ──
  useEffect(() => {
    if (!selected) return;
    const idx = imageItems.findIndex((item) => item.id === selected.id);
    if (idx === -1) return;
    // Prefetch three items on each side of the current selection.
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
      random_seed: randomOrderEnabled ? randomOrderSeed : undefined,
    }),
    [classFilterId, randomOrderEnabled, randomOrderSeed, statusFilter],
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
      setRandomOrderEnabled(false);
      previousDatasetIdRef.current = null;
      setBoxes([]);
      resetDraftState();
      setDeletedIds([]);
      setSelectedBoxKey(null);
      setHistory([]);
      setFuture([]);
      draftsRef.current.clear();
      setDraftMediaIds(new Set());
      setLoadedAnnotationMediaId(null);
      return;
    }

    let cancelled = false;
    const datasetChanged = previousDatasetIdRef.current !== selectedDatasetId;
    previousDatasetIdRef.current = selectedDatasetId;
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
    if (datasetChanged) {
      draftsRef.current.clear();
      setDraftMediaIds(new Set());
    }
    setLoadedAnnotationMediaId(null);
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
    if (orderedDatasetClasses.length === 0) {
      setActiveClassId(0);
    } else if (!orderedDatasetClasses.find((c) => c.id === activeClassId)) {
      setActiveClassId(orderedDatasetClasses[0].id);
    }
  }, [orderedDatasetClasses, activeClassId]);

  // ── load annotations for selected image ──
  useEffect(() => {
    if (!selected) return;
    // save current position as we navigate
    if (selectedDatasetId) {
      localStorage.setItem(`annotate_pos_${selectedDatasetId}`, String(selected.id));
    }
    const draft = draftsRef.current.get(selected.id);
    if (draft) {
      setPredictedMediaIds((current) => {
        if (!current.has(selected.id)) return current;
        const next = new Set(current);
        next.delete(selected.id);
        return next;
      });
      setBoxes(draft.boxes.map(cloneBox));
      setDeletedIds([...draft.deletedIds]);
      setSelectedBoxKey(null);
      setHistory([]);
      setFuture([]);
      setSaveStatus("idle");
      setLoadedAnnotationMediaId(selected.id);
      setMessage("已加载草稿标注，可以继续编辑或保存。");
      return;
    }
    let cancelled = false;
    setLoadedAnnotationMediaId(null);
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
          setLoadedAnnotationMediaId(selected.id);
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

  const layout = imageLayout(selected, canvasDims.width, canvasDims.height);
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
    setPredictedMediaIds((current) => {
      const next = new Set<number>();
      for (const id of current) {
        if (draftMediaIds.has(id) || predictionEmptyMediaIds.has(id)) next.add(id);
      }
      return next.size === current.size ? current : next;
    });
  }, [draftMediaIds, predictionEmptyMediaIds]);

  useEffect(() => {
    const annotatedIds = new Set(
      datasetMedia
        .filter((item) => item.annotation_status === "annotated" || item.annotation_count > 0)
        .map((item) => item.id),
    );
    if (annotatedIds.size === 0) return;
    setPredictedMediaIds((current) => {
      const next = new Set([...current].filter((id) => !annotatedIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setPredictionEmptyMediaIds((current) => {
      const next = new Set([...current].filter((id) => !annotatedIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [datasetMedia]);

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

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    if (!assistedActive || !assistedSettings || !selectedDatasetId || !selected) return;
    const currentItems = imageItemsRef.current;
    const selectedIndex = currentItems.findIndex((item) => item.id === selected.id);
    if (selectedIndex === -1) return;
    const radius = Math.max(0, Math.min(20, assistedSettings.preload_radius));
    const start = Math.max(0, selectedIndex - radius);
    const end = Math.min(currentItems.length, selectedIndex + radius + 1);

    const freshItems = currentItems
      .slice(start, end)
      .filter((item) => item.annotation_count === 0)
      .filter((item) => !draftsRef.current.has(item.id))
      .filter((item) => !assistedPredictedMediaIdsRef.current.has(item.id))
      .filter((item) => !predictionInFlightRef.current.has(item.id));

    const selectedReady = loadedAnnotationMediaId === selected.id;
    const selectedFresh = freshItems.find((item) => item.id === selected.id);

    const surroundingIds = freshItems
      .filter((item) => item.id !== selected.id)
      .map((item) => item.id);

    const candidates: number[] = [];
    if (selectedFresh && selectedReady) {
      candidates.push(selected.id);
    }
    for (const id of surroundingIds) {
      candidates.push(id);
    }
    if (candidates.length === 0) return;

    for (const id of candidates) {
      predictionInFlightRef.current.add(id);
    }

    api
      .predictAssistedAnnotations({ dataset_id: selectedDatasetId, media_asset_ids: candidates })
      .then((payload) => {
        let draftChanged = false;
        const newPredictedIds: number[] = [];
        const emptyPredictedIds: number[] = [];
        const failedIds: number[] = [];
        const successfulIds: number[] = [];
        for (const result of payload.results) {
          predictionInFlightRef.current.delete(result.media_asset_id);
          if (result.error) {
            failedIds.push(result.media_asset_id);
            if (result.media_asset_id === selectedIdRef.current) {
              setMessage(`辅助标注失败：${result.error}`);
            }
            continue;
          }

          assistedPredictedMediaIdsRef.current.add(result.media_asset_id);
          successfulIds.push(result.media_asset_id);

          const mediaItem = imageItemsRef.current.find((item) => item.id === result.media_asset_id);
          if (!mediaItem || mediaItem.annotation_count > 0) continue;

          const predictedBoxes = predictionBoxes(result.predictions);
          if (predictedBoxes.length === 0) {
            emptyPredictedIds.push(result.media_asset_id);
            if (result.media_asset_id === selectedIdRef.current && boxesRef.current.length === 0 && !draftBoxRef.current) {
              setMessage("辅助标注已完成，预测无框。");
            }
            continue;
          }

          if (result.media_asset_id === selectedIdRef.current) {
            if (boxesRef.current.length === 0 && !draftBoxRef.current && !draftsRef.current.has(result.media_asset_id)) {
              setBoxes(predictedBoxes);
              setDeletedIds([]);
              setSelectedBoxKey(null);
              setHistory([]);
              setFuture([]);
              setSaveStatus("idle");
              setMessage(`辅助标注已生成 ${predictedBoxes.length} 个草稿框，请检查后保存。`);
            }
          } else if (!draftsRef.current.has(result.media_asset_id)) {
            draftsRef.current.set(result.media_asset_id, { boxes: predictedBoxes, deletedIds: [] });
            newPredictedIds.push(result.media_asset_id);
            draftChanged = true;
          }
        }
        if (failedIds.length > 0) {
          setPredictionFailedMediaIds((current) => {
            const next = new Set(current);
            for (const id of failedIds) next.add(id);
            return next;
          });
        }
        if (successfulIds.length > 0) {
          setPredictionFailedMediaIds((current) => {
            let changed = false;
            const next = new Set(current);
            for (const id of successfulIds) {
              if (next.delete(id)) changed = true;
            }
            return changed ? next : current;
          });
        }
        if (draftChanged) {
          setDraftMediaIds(new Set(draftsRef.current.keys()));
        }
        if (newPredictedIds.length > 0 || emptyPredictedIds.length > 0) {
          setPredictedMediaIds((current) => {
            const next = new Set(current);
            for (const id of newPredictedIds) next.add(id);
            for (const id of emptyPredictedIds) next.add(id);
            return next;
          });
        }
        if (emptyPredictedIds.length > 0 || newPredictedIds.length > 0) {
          setPredictionEmptyMediaIds((current) => {
            const next = new Set(current);
            for (const id of emptyPredictedIds) next.add(id);
            for (const id of newPredictedIds) next.delete(id);
            return next;
          });
        }
      })
      .catch((error) => {
        for (const id of candidates) {
          predictionInFlightRef.current.delete(id);
        }
        setPredictionFailedMediaIds((current) => {
          const next = new Set(current);
          for (const id of candidates) next.add(id);
          return next;
        });
        setMessage(error instanceof Error ? error.message : "辅助标注预测失败");
      });
  }, [assistedActive, assistedSettings, loadedAnnotationMediaId, predictionBoxes, selected, selectedDatasetId]);

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
    let addedDraft = false;
    if (currentDraft && currentDraft.width >= 0.005 && currentDraft.height >= 0.005) {
      currentBoxes = [...currentBoxes, currentDraft];
      addedDraft = true;
    }
    if (currentDraft) {
      draftBoxRef.current = null;
      draftAnchorRef.current = null;
      pendingDraftPointRef.current = null;
      setDraftBox(null);
    }
    const currentDeleted = deletedIdsRef.current;
    const hasChanges =
      currentBoxes.some((box) => !box.id || box.dirty) || currentDeleted.length > 0 || addedDraft;
    if (!hasChanges) {
      const currentMedia = imageItemsRef.current.find((item) => item.id === currentId);
      if (currentMedia?.annotation_status === "annotated" || (currentMedia?.annotation_count ?? 0) > 0) {
        draftsRef.current.delete(currentId);
        setDraftMediaIds(new Set(draftsRef.current.keys()));
        return;
      }
    }
    draftsRef.current.set(currentId, {
      boxes: currentBoxes.map(cloneBox),
      deletedIds: [...currentDeleted],
    });
    setDraftMediaIds(new Set(draftsRef.current.keys()));
    setPredictedMediaIds((current) => {
      if (!current.has(currentId)) return current;
      const next = new Set(current);
      next.delete(currentId);
      return next;
    });
    setPredictionEmptyMediaIds((current) => {
      if (!current.has(currentId)) return current;
      const next = new Set(current);
      next.delete(currentId);
      return next;
    });
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

  useAnnotationShortcuts({
    classes: orderedDatasetClasses,
    imageItems,
    selectedId,
    selectedBoxKey,
    onChangeClass: changeClass,
    onUndo: undo,
    onRedo: redo,
    onDeleteSelected: deleteSelected,
    onSelectMedia: selectMedia,
  });

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

  const handleRandomOrderToggle = () => {
    saveCurrentAsDraft();
    setRandomOrderEnabled((current) => {
      const next = !current;
      if (next) {
        setRandomOrderSeed(Math.floor(Math.random() * 2147483647));
      }
      return next;
    });
    setSelectedId(null);
    if (mediaListRef.current) mediaListRef.current.scrollTop = 0;
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

  const refreshDatasetClasses = useCallback(async () => {
    if (!selectedDatasetId) return;
    const nextClasses = await api.datasetClasses(selectedDatasetId);
    setDatasetClasses(nextClasses);
  }, [selectedDatasetId]);

  const { saveAll, doSaveCurrent, doSaveAllDrafts } = useAnnotationSave({
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
    onSaved: refreshDatasetClasses,
  });

  // ── dataset selector view ──
  if (!selectedDatasetId) {
    return <DatasetPicker datasets={datasets} onSelectDataset={setSelectedDatasetId} />;
  }

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId);
  const totalAnnotated = currentDatasetStats?.annotated_media ?? datasetMedia.filter((m) => m.annotation_count > 0).length;
  const canvasMessage = assistedLoading ? "正在加载辅助标注模型..." : message;

  return (
    <section className="annotation-layout">
      <AnnotationSidebar
        selectedDatasetId={selectedDatasetId}
        selectedDatasetName={selectedDataset?.name}
        totalAnnotated={totalAnnotated}
        totalMedia={currentDatasetStats?.total_media ?? datasetMedia.length}
        statusFilter={statusFilter}
        onStatusFilterChange={handleStatusFilterChange}
        datasetClasses={orderedDatasetClasses}
        classFilterId={classFilterId}
        onClassFilterChange={handleClassFilterChange}
        mediaListRef={mediaListRef}
        onMediaListScroll={handleMediaListScroll}
        loadingDataset={loadingDataset}
        imageItems={imageItems}
        selectedMediaId={selected?.id}
        draftMediaIds={draftMediaIds}
        predictedMediaIds={predictedMediaIds}
        predictionEmptyMediaIds={predictionEmptyMediaIds}
        predictionFailedMediaIds={predictionFailedMediaIds}
        onSelectMedia={selectMedia}
        loadingMoreMedia={loadingMoreMedia}
        hasMoreMedia={hasMoreMedia}
        datasetMediaLength={datasetMedia.length}
        datasetMediaTotal={datasetMediaTotal}
        onLoadMoreMedia={() => void loadMoreMedia()}
        onBack={handleDatasetBack}
      />

      <div className="annotator">
        <AnnotationCanvas
          datasetClasses={orderedDatasetClasses}
          selectedBox={selectedBox}
          activeClassId={activeClassId}
          onChangeClass={changeClass}
          onOpenAddClass={() => {
            setNewClassDisplayName("");
            setAddClassError("");
            setAddClassOpen(true);
          }}
          stageContainerRef={stageContainerRef}
          stageRef={stageRef}
          transformerRef={transformerRef}
          canvasDims={canvasDims}
          onStartDraw={startDraw}
          onUpdateDraw={updateDraw}
          onFinishDraw={finishDraw}
          image={image}
          selected={selected}
          layout={layout}
          displayedBoxes={displayedBoxes}
          selectedBoxKey={selectedBoxKey}
          draftBox={draftBox}
          onSelectBox={setSelectedBoxKey}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onTransformStart={handleTransformStart}
          onTransformEnd={handleTransformEnd}
          saveStatus={saveStatus}
          message={canvasMessage}
          onUndo={undo}
          canUndo={history.length > 0}
          onRedo={redo}
          canRedo={future.length > 0}
          onDeleteSelected={deleteSelected}
          onSave={() => void saveAll()}
        />

        <div className="annotation-utility-toolbar" aria-label="标注工具栏">
          <label className="annotation-switch-row">
            <span>随机排序</span>
            <input
              type="checkbox"
              checked={randomOrderEnabled}
              onChange={handleRandomOrderToggle}
              disabled={loadingDataset || loadingMoreMedia}
            />
            <span className="annotation-switch-track" aria-hidden="true">
              <span className="annotation-switch-thumb" />
            </span>
          </label>
        </div>

        <AnnotationModals
          addClassOpen={addClassOpen}
          newClassDisplayName={newClassDisplayName}
          addClassError={addClassError}
          addingClass={addingClass}
          onNewClassDisplayNameChange={(value) => {
            setNewClassDisplayName(value);
            setAddClassError("");
          }}
          onCloseAddClass={() => setAddClassOpen(false)}
          onCreateClass={() => void handleCreateClass()}
          saveModalOpen={saveModalOpen}
          otherDraftCount={selected ? draftsRef.current.size - (draftsRef.current.has(selected.id) ? 1 : 0) : 0}
          onCloseSaveModal={() => setSaveModalOpen(false)}
          onSaveCurrent={() => {
            setSaveModalOpen(false);
            void doSaveCurrent();
          }}
          onSaveAllDrafts={() => {
            setSaveModalOpen(false);
            void doSaveAllDrafts();
          }}
          unsavedModalOpen={unsavedModalOpen}
          draftCount={draftsRef.current.size}
          onCancelUnsaved={() => {
            setUnsavedModalOpen(false);
            setPendingNavAction(null);
          }}
          onDiscardUnsaved={() => {
            const action = pendingNavAction;
            setUnsavedModalOpen(false);
            setPendingNavAction(null);
            draftsRef.current.clear();
            setDraftMediaIds(new Set());
            action?.();
          }}
          onSaveAllAndContinue={() => void (async () => {
            const success = await doSaveAllDrafts();
            if (success) {
              const action = pendingNavAction;
              setUnsavedModalOpen(false);
              setPendingNavAction(null);
              action?.();
            }
          })()}
        />
      </div>
    </section>
  );
}
