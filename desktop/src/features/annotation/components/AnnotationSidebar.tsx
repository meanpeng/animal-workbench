import type React from "react";
import { Select } from "../../../components/Select";
import type { DatasetDetail, Summary } from "../../../types";
import { truncateName } from "../uiUtils";
import { EmptyLine } from "./EmptyLine";

type StatusFilter = "all" | "annotated" | "unannotated";
type MediaItem = DatasetDetail["media"][number];

type AnnotationSidebarProps = {
  selectedDatasetId: number;
  selectedDatasetName?: string;
  totalAnnotated: number;
  totalMedia: number;
  statusFilter: StatusFilter;
  onStatusFilterChange: (next: StatusFilter) => void;
  datasetClasses: Summary["classes"];
  classFilterId: number | null;
  onClassFilterChange: (value: string) => void;
  mediaListRef: React.RefObject<HTMLDivElement>;
  onMediaListScroll: React.UIEventHandler<HTMLDivElement>;
  loadingDataset: boolean;
  imageItems: MediaItem[];
  selectedMediaId: number | undefined;
  draftMediaIds: Set<number>;
  predictedMediaIds: Set<number>;
  predictionEmptyMediaIds: Set<number>;
  predictionFailedMediaIds: Set<number>;
  onSelectMedia: (mediaId: number) => void;
  loadingMoreMedia: boolean;
  hasMoreMedia: boolean;
  datasetMediaLength: number;
  datasetMediaTotal: number;
  onLoadMoreMedia: () => void;
  onBack: () => void;
};

export function AnnotationSidebar({
  selectedDatasetId,
  selectedDatasetName,
  totalAnnotated,
  totalMedia,
  statusFilter,
  onStatusFilterChange,
  datasetClasses,
  classFilterId,
  onClassFilterChange,
  mediaListRef,
  onMediaListScroll,
  loadingDataset,
  imageItems,
  selectedMediaId,
  draftMediaIds,
  predictedMediaIds,
  predictionEmptyMediaIds,
  predictionFailedMediaIds,
  onSelectMedia,
  loadingMoreMedia,
  hasMoreMedia,
  datasetMediaLength,
  datasetMediaTotal,
  onLoadMoreMedia,
  onBack,
}: AnnotationSidebarProps) {
  const mediaStatus = (item: MediaItem) => {
    if (predictionFailedMediaIds.has(item.id)) {
      return { className: "failed", label: "辅助标注失败，可切换图片后重试" };
    }
    if (draftMediaIds.has(item.id)) {
      return { className: "draft", label: "有本地草稿，尚未保存" };
    }
    if (predictedMediaIds.has(item.id)) {
      if (predictionEmptyMediaIds.has(item.id)) {
        return { className: "predicted", label: "预测无框" };
      }
      return { className: "predicted", label: "辅助标注草稿，待检查保存" };
    }
    if (item.annotation_status === "annotated" || item.annotation_count > 0) {
      return {
        className: "saved",
        label: item.annotation_count > 0 ? `已保存 ${item.annotation_count} 个标注框` : "已检查，无标注框",
      };
    }
    return { className: "empty", label: "未标注" };
  };

  return (
    <aside className="annotation-sidebar">
      <div className="sidebar-header">
        <button className="back-link" onClick={onBack} title="返回选择数据集">
          ← 切换
        </button>
        <span className="sidebar-dataset-name" title={selectedDatasetName}>
          {selectedDatasetName ?? `#${selectedDatasetId}`}
        </span>
        <span className="sidebar-progress">{totalAnnotated}/{totalMedia}</span>
      </div>

      <div className="sidebar-filter-row">
        <Select
          className="filter-select-compact status-filter-select"
          options={[
            { value: "all", label: "全部" },
            { value: "annotated", label: "已标" },
            { value: "unannotated", label: "未标" },
          ]}
          value={statusFilter}
          onChange={(value) => onStatusFilterChange(value as StatusFilter)}
        />
        {datasetClasses.length > 0 ? (
          <Select
            className="filter-select-compact"
            options={[{ value: "", label: "全部类别" }, ...datasetClasses.map((cls) => ({ value: String(cls.id), label: cls.display_name }))]}
            value={String(classFilterId ?? "")}
            onChange={onClassFilterChange}
          />
        ) : null}
      </div>

      <div className="media-list" ref={mediaListRef} onScroll={onMediaListScroll}>
        {loadingDataset ? (
          <EmptyLine text="加载中..." />
        ) : imageItems.length === 0 ? (
          <EmptyLine text="无匹配图片" />
        ) : (
          <>
            {imageItems.map((item) => {
              const status = mediaStatus(item);
              const meta = predictionEmptyMediaIds.has(item.id)
                ? "预测无框"
                : item.annotation_count > 0
                  ? `${item.annotation_count} 框`
                  : item.annotation_status === "annotated"
                    ? "已检查"
                    : "";
              return (
                <button
                  key={item.id}
                  className={selectedMediaId === item.id ? "media-button active" : "media-button"}
                  onClick={() => onSelectMedia(item.id)}
                  title={`${item.original_name}\n${status.label}`}
                >
                  <span className="media-name">
                    <span className={`status-dot ${status.className}`} />
                    <span className="media-id">{item.id}</span> {truncateName(item.original_name)}
                  </span>
                  <span className="media-meta">{meta}</span>
                </button>
              );
            })}
            {loadingMoreMedia ? <EmptyLine text="Loading more..." /> : null}
            {!loadingMoreMedia && hasMoreMedia ? (
              <button className="media-button" onClick={onLoadMoreMedia}>
                <span className="media-name">Load more</span>
                <span className="media-meta">{datasetMediaLength}/{datasetMediaTotal}</span>
              </button>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
