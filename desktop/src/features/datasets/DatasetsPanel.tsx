import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, FolderPlus, ImagePlus, Layers3, Trash2, UploadCloud, X } from "lucide-react";
import { api } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Select } from "../../components/Select";
import type { ClassItem, Dataset, DatasetDetail, DatasetJob, DatasetMediaItem, PublicDataset } from "../../types";
import { formatBeijingTime } from "../../utils";

export function DatasetsPanel({
  datasets,
  onRefresh,
  onClassCreated,
  onSwitchToAnnotate,
}: {
  datasets: Dataset[];
  onRefresh: () => Promise<void>;
  onClassCreated: (classId: number) => void;
  onSwitchToAnnotate: (datasetId: number, mediaId: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("可以导入本地文件夹，或使用公开数据集预设启动后台任务。");
  const [publicDatasets, setPublicDatasets] = useState<PublicDataset[]>([]);
  const [datasetJobs, setDatasetJobs] = useState<DatasetJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [sampleLimitByKey, setSampleLimitByKey] = useState<Record<string, number>>({});
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);

  const hasActiveJob = useMemo(
    () => datasetJobs.some((j) => j.status === "queued" || j.status === "running"),
    [datasetJobs],
  );

  // Modal state for auto-create dialog
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalDefaultName, setModalDefaultName] = useState("");
  const [modalOnConfirm, setModalOnConfirm] = useState<{(name: string): Promise<void>}>(async () => {});

  // ImportDataModal state
  const [importModalOpen, setImportModalOpen] = useState(false);

  // "从已有数据集构建" state
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<number[]>([]);
  const [showTaskHistory, setShowTaskHistory] = useState(false);

  const refreshDatasetJobs = useCallback(async () => {
    const [nextPublicDatasets, nextJobs] = await Promise.all([api.publicDatasets(), api.datasetJobs()]);
    setPublicDatasets(nextPublicDatasets);
    setDatasetJobs(nextJobs);
    return nextJobs;
  }, []);

  useEffect(() => {
    const init = async () => {
      const nextJobs = await refreshDatasetJobs();
      const activeJob = nextJobs.find((j) => j.status === "queued" || j.status === "running");
      if (activeJob) {
        setActiveJobId(activeJob.id);
      }
    };
    void init();
  }, []);

  useEffect(() => {
    if (!activeJobId) return;
    let disconnected = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connectSSE = () => {
      if (disconnected) return;
      const events = new EventSource(api.datasetJobEventsUrl(activeJobId));
      events.onmessage = (event) => {
        let job: DatasetJob;
        try {
          job = JSON.parse(event.data) as DatasetJob;
        } catch {
          return;
        }
        retryCount = 0;
        setDatasetJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 20));
        setMessage(job.message);
        if (job.status === "completed" || job.status === "failed") {
          events.close();
          setActiveJobId(null);
          void onRefresh();
          void refreshDatasetJobs();
          if (job.status === "completed" && job.job_type === "folder_import") {
            let linkedMediaCount = 0;
            try {
              const summary = JSON.parse(job.result_summary || "{}");
              linkedMediaCount = summary.linked_media_count || summary.media_count || 0;
            } catch {
              linkedMediaCount = 0;
            }
            setMessage(linkedMediaCount > 0 ? `文件夹导入完成，已关联 ${linkedMediaCount} 个素材` : "文件夹导入完成");
          }
        }
      };
      events.onerror = () => {
        events.close();
        if (disconnected) return;
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          setMessage(`任务连接断开，正在重连 (${retryCount}/${MAX_RETRIES})...`);
          retryTimer = setTimeout(connectSSE, 3000);
        } else {
          disconnected = true;
          setActiveJobId(null);
          setMessage("任务状态连接已断开（后台任务仍在执行中），请刷新页面查看结果");
          void refreshDatasetJobs();
        }
      };
      return events;
    };

    const es = connectSSE();
    return () => {
      disconnected = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeJobId, onRefresh, refreshDatasetJobs]);

  // Called when user clicks "确认导入" in ImportDataModal with files selected
  const handleImportFiles = async (mode: "existing" | "new", existingId: number, newName: string, extractFrames: boolean, paths: string[]) => {
    setImportModalOpen(false);
    setBusy(true);
    setMessage("正在导入文件...");
    try {
      const result = await api.importMedia(paths, "导入批次", extractFrames);
      await onRefresh();
      const imported = result.imported;
      if (imported.length > 0) {
        const mediaIds = imported.map((m) => m.id);
        await assignMediaToDataset(mode, existingId, newName, mediaIds);
      } else {
        setMessage(`已处理 ${paths.length} 个文件`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入文件失败。");
    } finally {
      setBusy(false);
    }
  };

  // Called when user clicks "确认导入" in ImportDataModal with folder selected
  const handleImportFolder = async (mode: "existing" | "new", existingId: number, newName: string, extractFrames: boolean, folderPath: string) => {
    setImportModalOpen(false);
    setBusy(true);
    setMessage("正在启动文件夹导入任务...");
    try {
      const job = await api.importDatasetFolder({
        path: folderPath,
        name: newName.trim() || folderPath.split(/[\\/]/).filter(Boolean).pop() || "导入数据集",
        dataset_kind: "auto",
        create_dataset: mode === "new",
        extract_frames: extractFrames,
        target_dataset:
          mode === "existing"
            ? { mode: "existing", dataset_id: existingId }
            : { mode: "new", name: newName.trim() || folderPath.split(/[\\/]/).filter(Boolean).pop() || "导入数据集" },
      });
      setActiveJobId(job.id);
      setDatasetJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 20));
      setMessage("文件夹导入任务已启动，完成后将自动关联到所选数据集");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动文件夹导入任务失败。");
      setBusy(false);
    }
  };

  // Assign imported media to chosen dataset
  const assignMediaToDataset = async (mode: "existing" | "new", existingId: number, newName: string, mediaIds: number[]) => {
    setBusy(true);
    try {
      if (mode === "existing") {
        await api.addMediaToDataset(existingId, mediaIds);
        await onRefresh();
        setMessage(`已添加 ${mediaIds.length} 个素材到已有数据集`);
      } else {
        await api.createDataset({
          name: newName,
          dataset_type: "user",
          media_asset_ids: mediaIds,
        });
        await onRefresh();
        setMessage(`数据集「${newName}」已创建（${mediaIds.length} 个素材）`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  // Clean up orphaned media (imported but not linked to any dataset)
  const handleCleanupOrphans = async () => {
    if (!confirm("将删除所有未被数据集引用的媒体素材及其文件，确定继续？")) return;
    setBusy(true);
    setMessage("正在清理孤儿媒体...");
    try {
      const result = await api.cleanupOrphanMedia();
      await onRefresh();
      setMessage(`已清理 ${result.deleted_rows} 条孤儿媒体记录（${result.deleted_files} 个文件）`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理孤儿媒体失败");
    } finally {
      setBusy(false);
    }
  };

  // Open the import modal
  const openImportModal = () => {
    setImportModalOpen(true);
  };

  const startPublicDownload = async (item: PublicDataset) => {
    setBusy(true);
    try {
      const job = await api.downloadPublicDataset(item.key, {
        sample_limit: sampleLimitByKey[item.key] || item.default_sample_limit || undefined,
      });
      setActiveJobId(job.id);
      setDatasetJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)].slice(0, 20));
      setMessage(`${item.name} 下载任务已启动`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "公开数据下载任务启动失败");
    } finally {
      setBusy(false);
    }
  };

  const startPublicImport = async (item: PublicDataset) => {
    setBusy(true);
    try {
      const job = await api.importPublicDataset(item.key, {
        sample_limit: sampleLimitByKey[item.key] || item.default_sample_limit || undefined,
      });
      setActiveJobId(job.id);
      setDatasetJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)].slice(0, 20));
      setMessage(`${item.name} 导入任务已启动`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "公开数据导入任务启动失败");
    } finally {
      setBusy(false);
    }
  };

  const importExistingPublicFolder = async (item: PublicDataset) => {
    setBusy(true);
    try {
      const selected = await invoke<string[]>("pick_media_folder");
      if (selected.length === 0) {
        setMessage("没有选择文件夹");
        return;
      }
      const job = await api.importPublicDataset(item.key, {
        source_path: selected[0],
        sample_limit: sampleLimitByKey[item.key] || item.default_sample_limit || undefined,
      });
      setActiveJobId(job.id);
      setDatasetJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)].slice(0, 20));
      setMessage(`${item.name} 已有文件夹导入任务已启动`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "选择已有公开数据文件夹失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleDatasetSelection = (dsId: number) => {
    setSelectedDatasetIds((prev) =>
      prev.includes(dsId) ? prev.filter((id) => id !== dsId) : [...prev, dsId],
    );
  };

  const handleBuildDataset = async (name: string) => {
    if (selectedDatasetIds.length === 0 || !name.trim()) return;
    setBusy(true);
    setMessage("正在从已有数据集构建...");
    try {
      const dataset = await api.createFusionDataset({
        name: name.trim(),
        source_dataset_ids: selectedDatasetIds,
      });
      await onRefresh();
      setMessage(`数据集「${dataset.name}」已构建`);
      setSelectedDatasetIds([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "构建数据集失败");
    } finally {
      setBusy(false);
    }
  };

  // ── detail view ─────────────────────────────────────────
  if (selectedDataset) {
    return (
      <DatasetDetailView
        dataset={selectedDataset}
        onClassCreated={onClassCreated}
        onBack={async () => { setSelectedDataset(null); await onRefresh(); }}
        onAnnotate={(mediaId) => {
          onSwitchToAnnotate(selectedDataset.id, mediaId);
        }}
      />
    );
  }

  return (
    <section className="stack">
      <div className="toolbar">
        <button onClick={openImportModal} disabled={busy} title="导入新数据（图片、视频或文件夹）">
          <UploadCloud size={18} />
          <span>导入新数据</span>
        </button>
        <button onClick={() => void handleCleanupOrphans()} disabled={busy || hasActiveJob} title="清理未被数据集引用的孤儿媒体文件">
          <Trash2 size={18} />
          <span>清理孤儿媒体</span>
        </button>
        <span className="inline-status">{busy ? "处理中..." : message}</span>
      </div>

      <section className="panel flush">
        <h2>公开数据集</h2>
        <div className="public-grid">
          {publicDatasets.map((item) => {
            const job = latestJobForDataset(datasetJobs, item.key);
            const defaultLimit = item.default_sample_limit ?? 0;
            const itemJobActive = Boolean(job && (job.status === "queued" || job.status === "running"));
            const hasImportedDataset = datasets.some((ds) => ds.dataset_type === "public" && ds.name.includes(item.name));
            const completedImportJob = job?.job_type === "public_import" && job.status === "completed";
            const isLoaded = hasImportedDataset || completedImportJob;
            return (
              <article className="dataset-card" key={item.key}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.description}</span>
                </div>
                {defaultLimit && !isLoaded ? (
                  <label>
                    <span>样本上限</span>
                    <input
                      type="number"
                      min={1}
                      value={sampleLimitByKey[item.key] ?? defaultLimit}
                      onChange={(event) =>
                        setSampleLimitByKey((current) => ({ ...current, [item.key]: Number(event.target.value) }))
                      }
                    />
                  </label>
                ) : null}
                {isLoaded ? (
                  <div className="job-progress">
                    <span className="job-done-badge">✅ 已完成</span>
                  </div>
                ) : (
                  <>
                    <div className="job-progress">
                      <progress max={100} value={job?.percent ?? (item.downloaded ? 100 : 0)} />
                      <span>{job ? `${stageName(job.stage)} ${Math.round(job.percent)}%` : item.downloaded ? "已下载" : "未下载"}</span>
                    </div>
                    {job ? <p className={job.status === "failed" ? "job-message error" : "job-message"}>{job.error_message || job.message}</p> : null}
                  </>
                )}
                {isLoaded ? null : (
                <div className="card-actions">
                  <button onClick={() => void startPublicDownload(item)} disabled={busy || itemJobActive}>
                    <Download size={18} />
                    <span>下载</span>
                  </button>
                  <button onClick={() => void startPublicImport(item)} disabled={busy || itemJobActive || !item.importable}>
                    <UploadCloud size={18} />
                    <span>加载</span>
                  </button>
                  <button onClick={() => void importExistingPublicFolder(item)} disabled={busy || itemJobActive}>
                    <FolderPlus size={18} />
                    <span>选文件夹</span>
                  </button>
                </div>
              )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel flush">
        <div className="task-history-header">
          <h2>任务记录</h2>
          {datasetJobs.length > 0 && (
            <span className="task-badge">{datasetJobs.filter(j => j.status === "queued" || j.status === "running").length} 进行中</span>
          )}
          <button
            className="link-button"
            onClick={() => setShowTaskHistory((prev) => !prev)}
          >
            {showTaskHistory ? "收起" : "展开"}任务列表
          </button>
        </div>
        {showTaskHistory && (
          <div className="job-list">
            {datasetJobs.slice(0, 20).map((job) => (
              <div className="job-row" key={job.id}>
                <div className="job-row-name">
                  <strong>{jobTypeName(job.job_type)}</strong>
                  <span>{job.error_message || job.message}</span>
                </div>
                <div className="job-row-progress">
                  {(job.status === "queued" || job.status === "running") ? (
                    <>
                      <progress max={100} value={job.percent} />
                      <span>{stageName(job.stage)} {Math.round(job.percent)}%</span>
                    </>
                  ) : (
                    <span className="job-status-badge">{job.status === "completed" ? "✅ 完成" : job.status === "failed" ? "❌ 失败" : job.status}</span>
                  )}
                </div>
                <span className="job-row-time">{formatBeijingTime(job.created_at)}</span>
              </div>
            ))}
            {datasetJobs.length === 0 ? <EmptyLine text="暂无后台数据任务" /> : null}
          </div>
        )}
      </section>

      <section className="table-band">
        <div className="table-band-header">
          <h2>数据集</h2>
          <button
            onClick={() => {
              setModalTitle("请输入新数据集名称");
              setModalDefaultName("");
              setModalOnConfirm(() => async (name: string) => {
                await handleBuildDataset(name);
              });
              setModalOpen(true);
            }}
            disabled={selectedDatasetIds.length === 0 || busy}
            title="从已选数据集构建新数据集"
          >
            <Layers3 size={18} />
            <span>构建数据集（已选 {selectedDatasetIds.length} 个）</span>
          </button>
        </div>
        <DataTable<Dataset>
          columns={[
            { key: "select", title: "", align: "center", render: (ds) => (
              <input
                type="checkbox"
                checked={selectedDatasetIds.includes(ds.id)}
                onChange={() => toggleDatasetSelection(ds.id)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
            )},
            { key: "name", title: "名称", render: (ds) => (
              <button className="row-name" onClick={() => setSelectedDataset(ds)} title="查看详情">
                <strong>{ds.name}</strong>
              </button>
            )},
            { key: "type", title: "类型", align: "center", render: (ds) => datasetTypeName(ds.dataset_type) },
            { key: "stats", title: "统计", align: "center", render: (ds) => datasetStats(ds) },
            { key: "actions", title: "操作", align: "center", render: (ds) => (
              <button className="cell-action" onClick={() => setSelectedDataset(ds)}>查看</button>
            )},
          ]}
          data={datasets}
          rowKey={(ds) => ds.id}
          emptyText="还没有数据集"
        />
      </section>

      {/* ImportDataModal: unified dataset choice + data source */}
      <ImportDataModal
        open={importModalOpen}
        datasets={datasets}
        onPickFiles={handleImportFiles}
        onPickFolder={handleImportFolder}
        onCancel={() => setImportModalOpen(false)}
      />

      {/* Modal for auto-create naming (kept for backward compat) */}
      <Modal
        title={modalTitle}
        defaultValue={modalDefaultName}
        open={modalOpen}
        onConfirm={async (name) => {
          setModalOpen(false);
          await modalOnConfirm(name);
        }}
        onCancel={() => setModalOpen(false)}
      />
    </section>
  );
}


function ImportDataModal({
  open,
  datasets,
  onPickFiles,
  onPickFolder,
  onCancel,
}: {
  open: boolean;
  datasets: Dataset[];
  onPickFiles: (mode: "existing" | "new", existingId: number, newName: string, extractFrames: boolean, paths: string[]) => void;
  onPickFolder: (mode: "existing" | "new", existingId: number, newName: string, extractFrames: boolean, folderPath: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">(datasets.length > 0 ? "existing" : "new");
  const [selectedDatasetId, setSelectedDatasetId] = useState(datasets[0]?.id ?? 0);
  const [newName, setNewName] = useState("");
  const [extractFrames, setExtractFrames] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [picking, setPicking] = useState(false);

  const defaultName = useMemo(() => {
    return `导入 - ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
  }, []);

  useEffect(() => {
    if (open) {
      setMode(datasets.length > 0 ? "existing" : "new");
      setSelectedDatasetId(datasets[0]?.id ?? 0);
      setNewName(defaultName);
      setExtractFrames(false);
      setSubmitting(false);
      setSelectedFiles([]);
      setSelectedFolder("");
      setPicking(false);
    }
  }, [open, datasets, defaultName]);

  if (!open) return null;

  const handlePickFiles = async () => {
    setPicking(true);
    try {
      const paths = await invoke<string[]>("pick_media_files");
      setSelectedFiles(paths);
      setSelectedFolder("");
    } catch {
      // user cancelled
    } finally {
      setPicking(false);
    }
  };

  const handlePickFolder = async () => {
    setPicking(true);
    try {
      const paths = await invoke<string[]>("pick_media_folder");
      if (paths.length > 0) {
        setSelectedFolder(paths[0]);
      }
      setSelectedFiles([]);
    } catch {
      // user cancelled
    } finally {
      setPicking(false);
    }
  };

  const handleConfirm = () => {
    setSubmitting(true);
    if (selectedFolder) {
      onPickFolder(mode, selectedDatasetId, newName.trim() || defaultName, extractFrames, selectedFolder);
    } else {
      onPickFiles(mode, selectedDatasetId, newName.trim() || defaultName, extractFrames, selectedFiles);
    }
  };

  const hasSelection = selectedFiles.length > 0 || selectedFolder !== "";

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>导入新数据</h3>

        <p className="modal-desc">选择数据归属方式和数据来源，确认后开始导入。</p>

        <div className="dataset-select-options">
          {datasets.length > 0 && (
            <label className="radio-row">
              <input
                type="radio"
                name="importMode"
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
                disabled={submitting}
              />
              <span>添加到已有数据集</span>
            </label>
          )}
          <label className="radio-row">
            <input
              type="radio"
              name="importMode"
              checked={mode === "new"}
              onChange={() => setMode("new")}
              disabled={submitting}
            />
            <span>创建新数据集</span>
          </label>
        </div>

        {mode === "existing" && datasets.length > 0 ? (
          <Select
            className="modal-select"
            options={datasets.map((ds) => ({ value: String(ds.id), label: `${ds.name} (${datasetTypeName(ds.dataset_type)})` }))}
            value={String(selectedDatasetId)}
            onChange={(v) => setSelectedDatasetId(Number(v))}
            disabled={submitting}
          />
        ) : (
          <input
            className="modal-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="数据集名称"
            autoFocus
            disabled={submitting}
          />
        )}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={extractFrames}
            onChange={(e) => setExtractFrames(e.target.checked)}
            disabled={submitting}
          />
          <span>导入视频时自动抽帧（不保留原始视频，每视频最多 60 帧）</span>
        </label>

        {!hasSelection && (
          <div className="import-source-row">
            <button className="primary" onClick={handlePickFiles} disabled={submitting || picking}>
              <ImagePlus size={18} />
              <span>{picking ? "选择中..." : "选择图片/视频"}</span>
            </button>
            <button className="primary" onClick={handlePickFolder} disabled={submitting || picking}>
              <FolderPlus size={18} />
              <span>{picking ? "选择中..." : "选择文件夹"}</span>
            </button>
          </div>
        )}

        {selectedFiles.length > 0 && (
          <div className="import-path-preview">
            <div className="import-path-header">
              <ImagePlus size={16} />
              <span>已选择 {selectedFiles.length} 个文件</span>
              <button className="icon-button-sm" onClick={() => setSelectedFiles([])} disabled={submitting} title="清除选择">
                <X size={14} />
              </button>
            </div>
            <ul className="import-path-list">
              {selectedFiles.slice(0, 8).map((f, i) => (
                <li key={i} title={f}>{f.split(/[\\/]/).pop() || f}</li>
              ))}
              {selectedFiles.length > 8 && <li>... 还有 {selectedFiles.length - 8} 个文件</li>}
            </ul>
            <button className="text-button" onClick={handlePickFiles} disabled={submitting}>
              重新选择文件
            </button>
          </div>
        )}

        {selectedFolder && (
          <div className="import-path-preview">
            <div className="import-path-header">
              <FolderPlus size={16} />
              <span>已选择文件夹</span>
              <button className="icon-button-sm" onClick={() => setSelectedFolder("")} disabled={submitting} title="清除选择">
                <X size={14} />
              </button>
            </div>
            <div className="import-folder-path" title={selectedFolder}>
              {selectedFolder}
            </div>
            <button className="text-button" onClick={handlePickFolder} disabled={submitting}>
              重新选择文件夹
            </button>
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onCancel} disabled={submitting}>取消</button>
          {hasSelection && (
            <button className="primary" onClick={handleConfirm} disabled={submitting}>
              确认导入
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
function Modal({
  title,
  defaultValue,
  open,
  onConfirm,
  onCancel,
}: {
  title: string;
  defaultValue: string;
  open: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="数据集名称"
          autoFocus
        />
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={() => onConfirm(value.trim() || defaultValue)}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

function DatasetDetailView({
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const hasMore = mediaItems.length < total;
  const pageSize = 100;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (pageNum: number, append: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
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
        class_id: classFilter,
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
    return classes;
  }, [classes]);

  const handleAddClass = async () => {
    if (!newClassDisplayName.trim()) return;
    setAddingClass(true);
    setAddClassError("");
    try {
      let name = newClassDisplayName.trim().toLowerCase().replace(/\s+/g, "_");
      // sanitize to ASCII-only: keep [A-Za-z0-9_.-], replace consecutive invalid chars with single '_'
      name = name.replace(/[^a-z0-9_.-]+/g, "_").replace(/^_|_$/g, "").replace(/_{2,}/g, "_");
      if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        name = "class_" + Date.now();
      }
      const result = await api.createDatasetClass(datasetId, { name, display_name: newClassDisplayName.trim() });
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

  const hasFilters = search || classFilter !== undefined || statusFilter !== undefined;

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
      {stats && Object.keys(stats.class_counts).length > 0 ? (
        <div className="class-chips">
          <span className="class-chips-label">类别分布：</span>
          {Object.entries(stats.class_counts).map(([name, count]) => (
            <span className="class-chip" key={name}>{name} {count}</span>
          ))}
        </div>
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
        <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
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

      {addClassOpen ? (
        <div className="modal-overlay" onClick={() => setAddClassOpen(false)}>
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

function latestJobForDataset(jobs: DatasetJob[], key: string) {
  return jobs.find((job) => {
    try {
      const params = JSON.parse(job.params);
      return params.key === key || params.dataset_key === key || params.public_dataset_key === key;
    } catch {
      return false;
    }
  });
}

function stageName(stage: string) {
  return (
    {
      queued: "排队",
      downloading: "下载",
      extracting: "解压",
      scanning: "扫描",
      extracting_frames: "提取视频帧",
      parsing: "解析",
      importing_media: "导入素材",
      saving_annotations: "写入标注",
      finalizing: "收尾",
      completed: "完成",
      failed: "失败",
    } as Record<string, string>
  )[stage] ?? stage;
}

function jobTypeName(type: DatasetJob["job_type"]) {
  return {
    public_download: "公开数据下载",
    public_import: "公开数据加载",
    folder_import: "文件夹导入",
  }[type];
}

function datasetStats(dataset: Dataset) {
  try {
    const stats = JSON.parse(dataset.sample_stats || "{}") as {
      annotation_status?: string;
      media_count?: number;
      annotation_count?: number;
      format?: string;
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

function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

