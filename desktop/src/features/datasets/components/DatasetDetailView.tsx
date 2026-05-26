import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Trash2, UploadCloud } from "lucide-react";
import { api } from "../../../api";
import { DataTable } from "../../../components/DataTable";
import { Select } from "../../../components/Select";
import type { ClassItem, Dataset, DatasetClassDeletePreview, DatasetDetail, DatasetMediaItem } from "../../../types";

export function DatasetDetailView({
  dataset,
  onBack,
  onAnnotate,
  onClassCreated,
}: {
  dataset: Dataset;
  onBack: () => void;
  onAnnotate: (mediaId: number) => void;
  onClassCreated: (classId: number) => void;
}) {
  const datasetId = dataset.id;
  const datasetName = dataset.name;
  const [mediaItems, setMediaItems] = useState<DatasetMediaItem[]>([]);
  const [stats, setStats] = useState<DatasetDetail["stats"] | null>(null);
  const [total, setTotal] = useState(0);
  // Immediate stats from sample_stats — no API wait needed
  const instantStats = useMemo(() => {
    try {
      const raw = JSON.parse(dataset.sample_stats || "{}") as { media_count?: number; annotation_count?: number };
      return { total_media: raw.media_count ?? 0, total_annotations: raw.annotation_count ?? 0 };
    } catch { return { total_media: 0, total_annotations: 0 }; }
  }, [dataset.sample_stats]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<number | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [newClassDisplayName, setNewClassDisplayName] = useState("");
  const [addingClass, setAddingClass] = useState(false);
  const [addClassError, setAddClassError] = useState("");
  const [selectedClass, setSelectedClass] = useState<ClassItem | null>(null);
  const [editClassDisplayName, setEditClassDisplayName] = useState("");
  const [savingClass, setSavingClass] = useState(false);
  const [classActionError, setClassActionError] = useState("");
  const [deleteClassPreview, setDeleteClassPreview] = useState<DatasetClassDeletePreview | null>(null);
  const [deletingClass, setDeletingClass] = useState(false);
  const [confirmDeleteClass, setConfirmDeleteClass] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const hasMore = mediaItems.length < total;
  const pageSize = 100;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (pageNum: number, append: boolean, overrides?: { classFilter?: number | null }) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const nextClassFilter = overrides?.classFilter === null ? undefined : overrides?.classFilter ?? classFilter;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const result = await api.datasetMedia(datasetId, {
        limit: pageSize,
        offset: pageNum * pageSize,
        search: search || undefined,
        class_id: nextClassFilter,
        annotation_status: statusFilter,
      });
      if (append) {
        setMediaItems((prev) => [...prev, ...result.media]);
      } else {
        setMediaItems(result.media);
        setStats(result.stats);
        setTotal(result.total);
        setClasses(result.classes);
      }
      setPage(pageNum);
    } catch (err) {
      console.error(err);
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [datasetId, pageSize, search, classFilter, statusFilter]);

  // Initial load + reload on filter/dataset change
  useEffect(() => {
    loadPage(0, false);
  }, [loadPage]);

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadPage(page + 1, true);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, page, loadPage]);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await api.deleteDataset(datasetId);
      onBack();
    } catch (err) {
      console.error(err);
      setDeleteError(err instanceof Error ? err.message : "删除失败，请重试");
      setDeleting(false);
    }
  };

  const datasetClasses = useMemo(() => {
    return [...classes].sort((a, b) => {
      const countDiff = (stats?.class_counts[b.display_name] ?? 0) - (stats?.class_counts[a.display_name] ?? 0);
      if (countDiff !== 0) return countDiff;
      return a.sort_order - b.sort_order || a.id - b.id;
    });
  }, [classes, stats]);

  const handleAddClass = async () => {
    if (!newClassDisplayName.trim()) return;
    setAddingClass(true);
    setAddClassError("");
    try {
      const result = await api.createDatasetClass(datasetId, { name: newClassDisplayName.trim() });
      setNewClassDisplayName("");
      setAddClassOpen(false);
      setClasses(await api.datasetClasses(datasetId));
      onClassCreated(result.id);
    } catch (err) {
      console.error(err);
      setAddClassError(err instanceof Error ? err.message : "创建类别失败，请重试");
    } finally {
      setAddingClass(false);
    }
  };

  const handleOpenClassManager = async (item: ClassItem) => {
    setSelectedClass(item);
    setEditClassDisplayName(item.display_name);
    setClassActionError("");
    setDeleteClassPreview(null);
    setDeletingClass(true);
    try {
      const preview = await api.previewDeleteDatasetClass(datasetId, item.id);
      setDeleteClassPreview(preview);
    } catch (err) {
      console.error(err);
      setClassActionError(err instanceof Error ? err.message : "读取标签信息失败，请重试");
    } finally {
      setDeletingClass(false);
    }
  };

  const handleUpdateClass = async () => {
    if (!selectedClass || !editClassDisplayName.trim()) return;
    setSavingClass(true);
    setClassActionError("");
    try {
      await api.updateDatasetClass(datasetId, selectedClass.id, { name: editClassDisplayName.trim() });
      await loadPage(0, false);
      onClassCreated(selectedClass.id);
      setSelectedClass(null);
      setDeleteClassPreview(null);
    } catch (err) {
      console.error(err);
      setClassActionError(err instanceof Error ? err.message : "修改标签失败，请重试");
    } finally {
      setSavingClass(false);
    }
  };

  const handleDeleteClass = async () => {
    const target = selectedClass ?? deleteClassPreview?.class;
    if (!target) return;
    setDeletingClass(true);
    setClassActionError("");
    try {
      await api.deleteDatasetClass(datasetId, target.id);
      if (classFilter === target.id) {
        setClassFilter(undefined);
      }
      setClasses((prev) => prev.filter((item) => item.id !== target.id));
      setSelectedClass(null);
      setDeleteClassPreview(null);
      setConfirmDeleteClass(false);
      await loadPage(0, false, { classFilter: classFilter === target.id ? null : undefined });
      onClassCreated(target.id);
    } catch (err) {
      console.error(err);
      setClassActionError(err instanceof Error ? err.message : "删除标签失败，请重试");
    } finally {
      setDeletingClass(false);
    }
  };

  const hasFilters = search || classFilter !== undefined || statusFilter !== undefined;

  const [annotBusy, setAnnotBusy] = useState(false);

  const handleExportAnnotations = () => {
    api.exportAnnotations(datasetId, datasetName);
  };

  const handleImportAnnotations = async () => {
    setAnnotBusy(true);
    try {
      const selected = await invoke<string[]>("pick_media_folder");
      if (selected.length === 0) return;
      const result = await api.importAnnotations(datasetId, selected[0]);
      await loadPage(0, false);
      const cls = await api.datasetClasses(datasetId);
      setClasses(cls);
      alert(`导入完成：匹配 ${result.matched_media} 个素材，共 ${result.imported_boxes} 个标注框（${result.format} 格式）`);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "导入标注失败");
    } finally {
      setAnnotBusy(false);
    }
  };

  return (
    <section className="stack">
      <div className="detail-header">
        <button className="back-button" onClick={onBack}>
          ← 返回数据集列表
        </button>
        <h2>{datasetName}</h2>
        <div className="detail-header-actions">
          <button
            className="detail-action"
            onClick={() => { setNewClassDisplayName(""); setAddClassError(""); setAddClassOpen(true); }}
            title="新增标注类别"
          >
            + 新增类别
          </button>
          <button
            className="detail-action"
            onClick={handleExportAnnotations}
            title="导出 YOLO 格式标注（labels + dataset.yaml）"
          >
            <Download size={16} />
            <span>导出标注</span>
          </button>
          <button
            className="detail-action"
            onClick={() => void handleImportAnnotations()}
            disabled={annotBusy}
            title="从本地文件夹导入 YOLO 格式标注"
          >
            <UploadCloud size={16} />
            <span>{annotBusy ? "导入中..." : "导入标注"}</span>
          </button>
          <button
            className="detail-action danger"
            onClick={() => setConfirmDelete(true)}
            title="删除数据集"
          >
            <Trash2 size={16} />
            <span>删除</span>
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <strong>{stats?.total_media ?? instantStats.total_media}</strong>
          <span>素材总数</span>
        </div>
        <div className="stat-card">
          <strong>{stats?.annotated_media ?? "-"}</strong>
          <span>已标注素材</span>
        </div>
        <div className="stat-card">
          <strong>{stats?.total_annotations ?? instantStats.total_annotations}</strong>
          <span>标注框总数</span>
        </div>
      </div>
      {datasetClasses.length > 0 ? (
        <div className="class-chips">
          <span className="class-chips-label">标签：</span>
          {datasetClasses.map((item) => (
            <button
              className="class-chip manageable"
              key={item.id}
              type="button"
              onClick={() => void handleOpenClassManager(item)}
              title={`管理标签 ${item.display_name}`}
            >
              {item.display_name} {stats?.class_counts[item.display_name] ?? 0}
            </button>
          ))}
        </div>
      ) : null}
      {classActionError && !selectedClass ? (
        <p style={{ color: "#ef4444", margin: "-4px 0 8px", fontSize: "0.875rem" }}>{classActionError}</p>
      ) : null}

      <div className="filter-bar">
        <input
          placeholder="按文件名搜索..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
        />
        <div className="filter-selects">
          <Select
            className="filter-select"
            options={[{ value: "", label: "所有类别" }, ...datasetClasses.map((c) => ({ value: String(c.id), label: c.display_name }))]}
            value={String(classFilter ?? "")}
            onChange={(v) => setClassFilter(v ? Number(v) : undefined)}
          />
          <Select
            className="filter-select"
            options={[{ value: "", label: "所有状态" }, { value: "annotated", label: "已标注" }, { value: "unannotated", label: "未标注" }]}
            value={statusFilter ?? ""}
            onChange={(v) => setStatusFilter(v || undefined)}
          />
        </div>
        {hasFilters ? (
          <button className="link-button" onClick={() => { setSearch(""); setClassFilter(undefined); setStatusFilter(undefined); }}>
            清除筛选
          </button>
        ) : null}
        <span className="filter-count">
          {mediaItems.length > 0 ? `已加载 ${mediaItems.length} / ${total || "?"} 条` : total > 0 ? `共 ${total} 条` : ""}
        </span>
      </div>

      <DataTable<DatasetMediaItem>
        columns={[
          { key: "num", title: "#", align: "center", className: "num", render: (_, i) => i + 1 },
          { key: "name", title: "文件名", className: "name-cell", render: (item) => <span title={item.original_name}>{item.original_name}</span> },
          { key: "path", title: "路径", className: "path-cell", render: (item) => <span title={item.internal_path}>{item.internal_path}</span> },
          { key: "size", title: "尺寸", render: (item) => item.width && item.height ? `${item.width}×${item.height}` : "-" },
          { key: "annotations", title: "标注框", align: "center", className: "num", render: (item) => item.annotation_count },
          { key: "classes", title: "标注类别", render: (item) => item.class_names.length > 0
            ? <>{item.class_names.map((cn) => <span className="class-badge" key={cn}>{cn}</span>)}</>
            : <span className="muted">-</span>
          },
          { key: "actions", title: "操作", align: "center", render: (item) => (
            <button className="cell-action" onClick={() => onAnnotate(item.id)}>标注</button>
          )},
        ]}
        data={mediaItems}
        rowKey={(item) => item.id}
        emptyText={hasFilters ? "没有匹配的素材" : "该数据集暂无素材"}
        loading={loading}
      />

      {/* scroll sentinel for infinite loading */}
      <div ref={sentinelRef} style={{ height: 1 }} />
      {loadingMore ? <p className="empty-line">加载更多...</p> : null}

      {confirmDelete ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p style={{ color: "#64748b", margin: "0 0 16px", lineHeight: 1.6 }}>
              确定要删除数据集「{datasetName}」吗？此操作将移除该数据集及其所有关联数据，且不可恢复。
            </p>
            {deleteError ? <p style={{ color: "#ef4444", margin: "0 0 12px", fontSize: "0.875rem" }}>{deleteError}</p> : null}
            <div className="modal-actions">
              <button onClick={() => setConfirmDelete(false)} disabled={deleting}>取消</button>
              <button className="primary danger" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedClass && !confirmDeleteClass ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>管理标签</h3>
            <label className="storage-field">
              <span>标签名</span>
              <input
                value={editClassDisplayName}
                onChange={(e) => { setEditClassDisplayName(e.target.value); setClassActionError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !savingClass) void handleUpdateClass(); }}
                autoFocus
                disabled={savingClass || deletingClass}
              />
            </label>
            {classActionError ? <p style={{ color: "#ef4444", margin: "0 0 12px", fontSize: "0.875rem" }}>{classActionError}</p> : null}
            <div className="modal-actions split">
              <button className="link-button danger" type="button" onClick={() => setConfirmDeleteClass(true)} disabled={savingClass || deletingClass}>
                <Trash2 size={15} />
                <span>删除标签</span>
              </button>
              <button onClick={() => { setSelectedClass(null); setDeleteClassPreview(null); setClassActionError(""); setConfirmDeleteClass(false); }} disabled={savingClass || deletingClass}>取消</button>
              <button className="primary" onClick={() => void handleUpdateClass()} disabled={savingClass || deletingClass || !editClassDisplayName.trim()}>
                {savingClass ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedClass && confirmDeleteClass ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除标签</h3>
            <div className="class-delete-panel">
              {deletingClass && !deleteClassPreview ? (
                <p>正在读取标签标注数量...</p>
              ) : deleteClassPreview && deleteClassPreview.affected_media_count > 0 ? (
                <p>
                  标签“{selectedClass.display_name}”下还有 {deleteClassPreview.affected_media_count} 张已标注图片、
                  {deleteClassPreview.annotation_count} 个标注框。删除后，这些标注框会被移除；没有其他标签标注的图片会回到未标注状态。
                </p>
              ) : (
                <p>标签“{selectedClass.display_name}”下没有标注，删除后会从当前数据集的标签列表中移除。</p>
              )}
            </div>
            {classActionError ? <p style={{ color: "#ef4444", margin: "0 0 12px", fontSize: "0.875rem" }}>{classActionError}</p> : null}
            <div className="modal-actions">
              <button onClick={() => { setConfirmDeleteClass(false); setClassActionError(""); }} disabled={deletingClass}>返回</button>
              <button className="primary danger" onClick={() => void handleDeleteClass()} disabled={deletingClass || !deleteClassPreview}>
                {deletingClass ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addClassOpen ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>新增标注类别</h3>
            <input
              value={newClassDisplayName}
              onChange={(e) => { setNewClassDisplayName(e.target.value); setAddClassError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !addingClass) void handleAddClass(); }}
              placeholder="类别名称，如：野猪"
              autoFocus
              disabled={addingClass}
            />
            {addClassError ? <p style={{ color: "#ef4444", margin: "8px 0 0", fontSize: "0.875rem" }}>{addClassError}</p> : null}
            <div className="modal-actions">
              <button onClick={() => setAddClassOpen(false)} disabled={addingClass}>取消</button>
              <button className="primary" onClick={() => void handleAddClass()} disabled={addingClass}>
                {addingClass ? "创建中..." : "确定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
