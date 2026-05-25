import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, FolderPlus, Layers3, Trash2, UploadCloud } from "lucide-react";
import { api } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Select } from "../../components/Select";
import type { Dataset, DatasetJob, PublicDataset } from "../../types";
import { formatBeijingTime } from "../../utils";
import { DatasetDetailView } from "./components/DatasetDetailView";
import { EmptyLine } from "./components/EmptyLine";
import { ImportDataModal } from "./components/ImportDataModal";
import { Modal } from "./components/Modal";
import { datasetStats, datasetTypeName, defaultFusionDatasetName, jobTypeName, latestJobForDataset, stageName } from "./datasetUtils";

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

  const [fusionModalOpen, setFusionModalOpen] = useState(false);
  const [fusionDefaultName, setFusionDefaultName] = useState("");

  // ImportDataModal state
  const [importModalOpen, setImportModalOpen] = useState(false);

  // State for building a dataset from existing datasets.
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

  // Called when the user confirms an import with files selected.
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

  // Called when the user confirms an import with a folder selected.
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
        sample_limit: sampleLimitByKey[item.key] || undefined,
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
    if (selectedDatasetIds.length === 0) {
      setMessage("请先选择要融合的数据集");
      return;
    }
    if (!name.trim()) {
      setMessage("请输入融合数据集名称");
      return;
    }
    setBusy(true);
    setMessage("正在创建融合数据集任务...");
    try {
      const job = await api.createFusionDatasetJob({
        name: name.trim(),
        source_dataset_ids: selectedDatasetIds,
      });
      setActiveJobId(job.id);
      setDatasetJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)].slice(0, 20));
      setMessage("融合数据集构建任务已启动");
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
            const isLoaded = hasImportedDataset;
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
                    <span className="public-loaded-badge">已完成</span>
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
                    <span className="job-status-badge" data-status={job.status}>
                      {job.status === "completed" ? "完成" : job.status === "failed" ? "失败" : job.status}
                    </span>
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
              setFusionDefaultName(defaultFusionDatasetName());
              setFusionModalOpen(true);
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

      <Modal
        title="请输入新数据集名称"
        defaultValue={fusionDefaultName}
        open={fusionModalOpen}
        onConfirm={async (name) => {
          setFusionModalOpen(false);
          await handleBuildDataset(name);
        }}
        onCancel={() => setFusionModalOpen(false)}
      />
    </section>
  );
}
