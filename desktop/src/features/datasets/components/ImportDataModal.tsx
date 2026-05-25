import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPlus, ImagePlus, X } from "lucide-react";
import { Select } from "../../../components/Select";
import type { Dataset } from "../../../types";
import { datasetTypeName } from "../datasetUtils";

export function ImportDataModal({
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
    <div className="modal-overlay">
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
