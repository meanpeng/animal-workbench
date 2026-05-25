import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LucideIcon } from "lucide-react";
import {
  ChartSpline,
  CirclePlay,
  Database,
  FileCog,
  FolderOpen,
  LayoutDashboard,
  Play,
  RefreshCw,
  Save,
  ScanSearch,
  Settings2,
  SquarePen,
  X,
} from "lucide-react";
import { api } from "./api";
import type {
  AnnotationBatch,
  AssistedAnnotationSettings,
  Dataset,
  Experiment,
  ModelItem,
  StorageSettings,
  Summary,
  TrainingJob,
} from "./types";
import { DatasetsPanel } from "./features/datasets/DatasetsPanel";
import { Annotate } from "./features/annotation/Annotate";
import { TrainingPanel } from "./features/training/TrainingPanel";
import { formatBeijingTime } from "./utils";

type View = "dashboard" | "datasets" | "annotate" | "training" | "results";

const navItems: Array<{ view: View; label: string; icon: LucideIcon }> = [
  { view: "dashboard", label: "首页", icon: LayoutDashboard },
  { view: "datasets", label: "数据集", icon: Database },
  { view: "annotate", label: "标注", icon: SquarePen },
  { view: "training", label: "训练", icon: CirclePlay },
  { view: "results", label: "结果", icon: ChartSpline },
];

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [batches, setBatches] = useState<AnnotationBatch[]>([]);
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [status, setStatus] = useState("正在连接工作区");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const annotateTargetRef = useRef<{datasetId: number; mediaId: number} | null>(null);

  const refreshCore = async () => {
    try {
      const [nextSummary, nextDatasets] = await Promise.all([api.summary(), api.datasets()]);
      setSummary(nextSummary);
      setDatasets(nextDatasets);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "后端服务未就绪");
    }
  };

  const refreshDashboard = async () => {
    try {
      const [nextBatches, nextJobs, nextModels] = await Promise.all([
        api.batches(),
        api.jobs(),
        api.models(),
      ]);
      setBatches(nextBatches);
      setJobs(nextJobs);
      setModels(nextModels);
    } catch { /* core refresh handles status */ }
  };

  const refreshTraining = async () => {
    try {
      const nextJobs = await api.jobs();
      setJobs(nextJobs);
    } catch { /* ignore */ }
  };

  const refreshResults = async () => {
    try {
      const [nextModels, nextExperiments] = await Promise.all([api.models(), api.experiments()]);
      setModels(nextModels);
      setExperiments(nextExperiments);
    } catch { /* ignore */ }
  };

  const refresh = async () => {
    await Promise.all([
      refreshCore(),
      refreshDashboard(),
      refreshResults(),
    ]);
    setStatus("工作区已同步");
  };

  const switchView = (next: View) => {
    setView(next);
    if (next === "dashboard") void Promise.all([refreshCore(), refreshDashboard()]);
    else if (next === "training") void Promise.all([refreshCore(), refreshTraining()]);
    else if (next === "results") void Promise.all([refreshCore(), refreshResults()]);
    else void refreshCore();
  };

  useEffect(() => {
    void refresh();
  }, []);

  const title = useMemo(() => {
    if (!summary) return "Animal Detection Workbench";
    return summary.project.reserve_name || summary.project.name;
  }, [summary]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <ScanSearch size={24} />
          <div>
            <strong>动物检测工作台</strong>
            <span>{title}</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.view}
                className={view === item.view ? "nav-button active" : "nav-button"}
                onClick={() => switchView(item.view)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <button className="utility-button" onClick={() => void refresh()} title="刷新">
          <RefreshCw size={18} />
          <span>刷新状态</span>
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">{status}</span>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" title="全局设置" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={18} />
            </button>
          </div>
        </header>

        {view === "dashboard" && <Dashboard summary={summary} batches={batches} jobs={jobs} models={models} />}
        {view === "datasets" && <DatasetsPanel datasets={datasets} onRefresh={refresh} onClassCreated={() => { void refresh(); }} onSwitchToAnnotate={(datasetId, mediaId) => {annotateTargetRef.current = { datasetId, mediaId }; setView("annotate"); }} />}
        {view === "annotate" && <Annotate datasets={datasets} initialDatasetId={annotateTargetRef.current?.datasetId ?? null} initialMediaId={annotateTargetRef.current?.mediaId ?? null} onTargetConsumed={() => { annotateTargetRef.current = null; }} />}
        {view === "training" && <TrainingPanel datasets={datasets} jobs={jobs} models={models} onRefresh={refresh} />}
        {view === "results" && <Results models={models} experiments={experiments} />}
        {settingsOpen ? <GlobalSettingsModal onClose={() => setSettingsOpen(false)} onSaved={refresh} /> : null}
      </main>
    </div>
  );
}

function GlobalSettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [assistSettings, setAssistSettings] = useState<AssistedAnnotationSettings>({
    enabled: false,
    model_path: "",
    confidence: 0.25,
    preload_radius: 3,
    image_size: 640,
    device: "auto",
  });
  const [dataRoot, setDataRoot] = useState("");
  const [message, setMessage] = useState("公开数据集、训练导出、视频抽帧和辅助标注配置都会保存在这里。");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.storageSettings(), api.assistedAnnotationSettings()])
      .then(([nextStorage, nextAssist]) => {
        setSettings(nextStorage);
        setDataRoot(nextStorage.data_root);
        setAssistSettings(nextAssist);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "读取设置失败"));
  }, []);

  const pickFolder = async () => {
    const selected = await invoke<string[]>("pick_media_folder");
    if (selected[0]) setDataRoot(selected[0]);
  };

  const pickModel = async () => {
    const selected = await invoke<string | null>("pick_model_file");
    if (selected) {
      setAssistSettings((current) => ({ ...current, model_path: selected, enabled: true }));
    }
  };

  const save = async () => {
    if (!dataRoot.trim()) return;
    setBusy(true);
    try {
      const [next] = await Promise.all([
        api.updateStorageSettings({ data_root: dataRoot.trim() }),
        api.updateAssistedAnnotationSettings({
          ...assistSettings,
          model_path: assistSettings.model_path.trim(),
          confidence: Number(assistSettings.confidence),
          preload_radius: Number(assistSettings.preload_radius),
          image_size: Number(assistSettings.image_size),
          device: assistSettings.device.trim() || "auto",
        }),
      ]);
      setSettings(next);
      setDataRoot(next.data_root);
      setMessage("已保存。辅助标注设置会在下一次进入标注详情页时生效。");
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog storage-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title-row">
          <h3>全局设置</h3>
          <button className="icon-button-sm" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <section className="global-settings-section">
          <h4>存储设置</h4>
          <label className="storage-field">
            <span>数据集大文件目录</span>
            <div className="path-input-row">
              <input value={dataRoot} onChange={(event) => setDataRoot(event.target.value)} placeholder="选择 C 盘以外的目录" />
              <button onClick={() => void pickFolder()} disabled={busy} title="选择文件夹">
                <FolderOpen size={16} />
              </button>
            </div>
          </label>
        </section>
        {settings ? (
          <div className="storage-paths">
            <span>数据库：{settings.db_path}</span>
            <span>公开数据：{settings.public_data_dir}</span>
            <span>训练缓存：{settings.runtime_dir}</span>
          </div>
        ) : null}
        <section className="global-settings-section">
          <div className="settings-section-title">
            <h4>辅助标注</h4>
            <label className="checkbox-row settings-toggle">
              <input
                type="checkbox"
                checked={assistSettings.enabled}
                onChange={(event) => setAssistSettings((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>进入标注详情页时自动预标注</span>
            </label>
          </div>
          <label className="storage-field">
            <span>YOLO 模型位置</span>
            <div className="path-input-row">
              <input
                value={assistSettings.model_path}
                onChange={(event) => setAssistSettings((current) => ({ ...current, model_path: event.target.value }))}
                placeholder="选择已训练好的 .pt 权重文件"
              />
              <button onClick={() => void pickModel()} disabled={busy} title="选择模型文件">
                <FileCog size={16} />
              </button>
            </div>
          </label>
          <div className="settings-grid">
            <label className="storage-field">
              <span>置信度阈值</span>
              <input
                type="number"
                min="0.01"
                max="0.99"
                step="0.01"
                value={assistSettings.confidence}
                onChange={(event) => setAssistSettings((current) => ({ ...current, confidence: Number(event.target.value) }))}
              />
            </label>
            <label className="storage-field">
              <span>前后预标注张数</span>
              <input
                type="number"
                min="0"
                max="20"
                step="1"
                value={assistSettings.preload_radius}
                onChange={(event) => setAssistSettings((current) => ({ ...current, preload_radius: Number(event.target.value) }))}
              />
            </label>
            <label className="storage-field">
              <span>推理尺寸</span>
              <input
                type="number"
                min="128"
                max="2048"
                step="32"
                value={assistSettings.image_size}
                onChange={(event) => setAssistSettings((current) => ({ ...current, image_size: Number(event.target.value) }))}
              />
            </label>
            <label className="storage-field">
              <span>设备</span>
              <input
                value={assistSettings.device}
                onChange={(event) => setAssistSettings((current) => ({ ...current, device: event.target.value }))}
                placeholder="auto / cpu / 0"
              />
            </label>
          </div>
        </section>
        <p className="helper-text">{message}</p>
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void save()} disabled={busy || !dataRoot.trim()}>
            <Save size={16} />
            <span>{busy ? "保存中..." : "保存"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function viewTitle(view: View) {
  return {
    dashboard: "总览",
    datasets: "数据集管理",
    annotate: "标注审核",
    training: "训练向导",
    results: "实验结果",
  }[view];
}

function Dashboard({
  summary,
  batches,
  jobs,
  models,
}: {
  summary: Summary | null;
  batches: AnnotationBatch[];
  jobs: TrainingJob[];
  models: ModelItem[];
}) {
  const counts = summary?.counts ?? {};
  return (
    <section className="content-grid">
      <Metric label="媒体素材" value={counts.media_assets ?? 0} />
      <Metric label="数据集" value={counts.datasets ?? 0} />
      <Metric label="标注框" value={counts.annotations ?? 0} />
      <Metric label="模型版本" value={counts.models ?? 0} />

      <section className="panel wide">
        <h2>标注进度</h2>
        <div className="row-list">
          {batches.length === 0 ? <EmptyLine text="导入图片后会自动生成标注批次" /> : null}
          {batches.map((batch) => (
            <div className="list-row" key={batch.id}>
              <div>
                <strong>{batch.name}</strong>
                <span>{batch.status}</span>
              </div>
              <progress max={Math.max(batch.total_items, 1)} value={batch.completed_items} />
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>最近训练</h2>
        <div className="row-list">
          {jobs.length === 0 ? <EmptyLine text="训练任务会显示在这里" /> : null}
          {jobs.slice(0, 4).map((job) => (
            <div className="list-row compact" key={job.id}>
              <strong>{job.name}</strong>
              <span>{job.status}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>推荐模型</h2>
        <div className="row-list">
          {models.length === 0 ? <EmptyLine text="训练完成后会生成模型版本" /> : null}
          {models.slice(0, 4).map((model) => (
            <div className="list-row compact" key={model.id}>
              <strong>{model.name}</strong>
              <span>{model.is_recommended ? "当前推荐" : "历史版本"}</span>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function Results({ models, experiments }: { models: ModelItem[]; experiments: Experiment[] }) {
  return (
    <section className="content-grid">
      <section className="panel wide">
        <h2>实验</h2>
        <div className="row-list">
          {experiments.map((experiment) => (
            <div className="list-row" key={experiment.id}>
              <div>
                <strong>{experiment.name}</strong>
                <span>{formatBeijingTime(experiment.created_at)}</span>
              </div>
              <button title="用这个模型继续预测">
                <Play size={18} />
                <span>继续预测</span>
              </button>
            </div>
          ))}
          {experiments.length === 0 ? <EmptyLine text="训练完成后会显示实验指标和曲线" /> : null}
        </div>
      </section>
      <section className="panel">
        <h2>模型版本</h2>
        <div className="row-list">
          {models.map((model) => (
            <div className="list-row compact" key={model.id}>
              <strong>{model.name}</strong>
              <span>{model.is_recommended ? "推荐" : "可用"}</span>
            </div>
          ))}
          {models.length === 0 ? <EmptyLine text="暂无模型版本" /> : null}
        </div>
      </section>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <section className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </section>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

export default App;
