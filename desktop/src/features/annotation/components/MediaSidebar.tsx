import { useEffect, useState } from "react";
import { Select } from "../../../components/Select";
import { api } from "../../../api";
import type { ClassItem, Dataset, DatasetDetail, DatasetMediaItem } from "../../../types";
import { truncateName, datasetTypeName, datasetStats } from "../utils";

function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
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

export function DatasetSelector({
  datasets,
  onSelectDataset,
}: {
  datasets: Dataset[];
  onSelectDataset: (id: number) => void;
}) {
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
              onClick={() => onSelectDataset(ds.id)}
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

export function MediaSidebar({
  selectedDatasetId,
  selectedDataset,
  totalAnnotated,
  datasetMediaTotal,
  currentDatasetStats,
  datasetClasses,
  statusFilter,
  classFilterId,
  loadingDataset,
  loadingMoreMedia,
  hasMoreMedia,
  imageItems,
  selected,
  draftMediaIds,
  mediaListRef,
  onStatusFilterChange,
  onClassFilterChange,
  onDatasetBack,
  onMediaClick,
  onLoadMore,
  onMediaListScroll,
}: {
  selectedDatasetId: number;
  selectedDataset: Dataset | undefined;
  totalAnnotated: number;
  datasetMediaTotal: number;
  currentDatasetStats: DatasetDetail["stats"] | null;
  datasetClasses: ClassItem[];
  statusFilter: "all" | "annotated" | "unannotated";
  classFilterId: number | null;
  loadingDataset: boolean;
  loadingMoreMedia: boolean;
  hasMoreMedia: boolean;
  imageItems: DatasetMediaItem[];
  selected: DatasetMediaItem | undefined;
  draftMediaIds: Set<number>;
  mediaListRef: React.RefObject<HTMLDivElement>;
  onStatusFilterChange: (next: "all" | "annotated" | "unannotated") => void;
  onClassFilterChange: (value: string) => void;
  onDatasetBack: () => void;
  onMediaClick: (mediaId: number) => void;
  onLoadMore: () => void;
  onMediaListScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}) {
  return (
    <aside className="annotation-sidebar">
      <div className="sidebar-header">
        <button className="back-link" onClick={onDatasetBack} title="返回选择数据集">
          ← 切换
        </button>
        <span className="sidebar-dataset-name" title={selectedDataset?.name}>{selectedDataset?.name ?? `#${selectedDatasetId}`}</span>
        <span className="sidebar-progress">{totalAnnotated}/{currentDatasetStats?.total_media ?? 0}</span>
      </div>

      <div className="sidebar-filter-row">
        <div className="filter-btn-group">
          <button className={`filter-btn ${statusFilter === "all" ? "active" : ""}`} onClick={() => onStatusFilterChange("all")}>全部</button>
          <button className={`filter-btn ${statusFilter === "annotated" ? "active" : ""}`} onClick={() => onStatusFilterChange("annotated")}>已标</button>
          <button className={`filter-btn ${statusFilter === "unannotated" ? "active" : ""}`} onClick={() => onStatusFilterChange("unannotated")}>未标</button>
        </div>
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
            {imageItems.map((item) => (
              <button
                key={item.id}
                className={selected?.id === item.id ? "media-button active" : "media-button"}
                onClick={() => onMediaClick(item.id)}
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
              <button className="media-button" onClick={() => onLoadMore()}>
                <span className="media-name">Load more</span>
                <span className="media-meta">{imageItems.length}/{datasetMediaTotal}</span>
              </button>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
