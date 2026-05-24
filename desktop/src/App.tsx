import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CheckCircle2,
  Database,
  Layers3,
  ListChecks,
  Play,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { api } from "./api";
import { DataTable } from "./components/DataTable";
import { Select } from "./components/Select";
import type {
  AnnotationBatch,
  Dataset,
  Experiment,
  ModelItem,
  Summary,
  TrainingJob,
} from "./types";
import { DatasetsPanel } from "./features/datasets/DatasetsPanel";
import { Annotate } from "./features/annotation/Annotate";
import { formatBeijingTime } from "./utils";

type View = "dashboard" | "datasets" | "annotate" | "training" | "results";

const navItems: Array<{ view: View; label: string; icon: typeof Database }> = [
  { view: "dashboard", label: "首页", icon: BarChart3 },
  { view: "datasets", label: "数据集", icon: Layers3 },
  { view: "annotate", label: "标注", icon: ListChecks },
  { view: "training", label: "训练", icon: Play },
  { view: "results", label: "结果", icon: CheckCircle2 },
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
          <Sparkles size={24} />
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
            <button className="icon-button" title="工作区设置">
              <Settings2 size={18} />
            </button>
          </div>
        </header>

        {view === "dashboard" && <Dashboard summary={summary} batches={batches} jobs={jobs} models={models} />}
        {view === "datasets" && <DatasetsPanel datasets={datasets} onRefresh={refresh} onClassCreated={() => { void refresh(); }} onSwitchToAnnotate={(datasetId, mediaId) => {annotateTargetRef.current = { datasetId, mediaId }; setView("annotate"); }} />}
        {view === "annotate" && <Annotate datasets={datasets} initialDatasetId={annotateTargetRef.current?.datasetId ?? null} initialMediaId={annotateTargetRef.current?.mediaId ?? null} onTargetConsumed={() => { annotateTargetRef.current = null; }} />}
        {view === "training" && <Training datasets={datasets} jobs={jobs} onRefresh={refresh} />}
        {view === "results" && <Results models={models} experiments={experiments} />}
      </main>
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

function Training({
  datasets,
  jobs,
  onRefresh,
}: {
  datasets: Dataset[];
  jobs: TrainingJob[];
  onRefresh: () => Promise<void>;
}) {
  const [datasetId, setDatasetId] = useState<number | "">(datasets[0]?.id ?? "");
  const [epochs, setEpochs] = useState(50);
  const [imageSize, setImageSize] = useState(960);
  const [batchSize, setBatchSize] = useState(8);
  const [device, setDevice] = useState("auto");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [message, setMessage] = useState("训练任务会先导出临时 YOLO 数据集，再进入训练队列。");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!datasetId && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasets, datasetId]);

  const startTraining = async () => {
    if (!datasetId) return;
    setBusy(true);
    setMessage("正在创建训练任务");
    try {
      await api.createTrainingJob({
        dataset_id: Number(datasetId),
        name: `训练 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
        epochs,
        image_size: imageSize,
        batch_size: batchSize,
        device,
        mode: "finetune",
        run_yolo: false,
      });
      await onRefresh();
      setMessage("训练任务已创建，后端已开始导出临时数据集");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建训练任务失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="training-grid">
      <section className="panel flush">
        <h2>1. 选择数据集</h2>
        <Select
          options={[{ value: "", label: "请选择" }, ...datasets.map((d) => ({ value: String(d.id), label: d.name }))]}
          value={String(datasetId ?? "")}
          onChange={(v) => setDatasetId(Number(v))}
        />
      </section>

      <section className="panel flush">
        <h2>2. 推荐参数</h2>
        <div className="control-grid">
          <label>
            <span>训练轮数</span>
            <input type="number" min={1} max={1000} value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} />
          </label>
          <label>
            <span>图片尺寸</span>
            <input
              type="number"
              min={128}
              max={2048}
              value={imageSize}
              onChange={(e) => setImageSize(Number(e.target.value))}
            />
          </label>
          <label>
            <span>批大小</span>
            <input
              type="number"
              min={1}
              max={128}
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
            />
          </label>
          <label>
            <span>设备</span>
            <Select
              options={[{ value: "auto", label: "自动" }, { value: "0", label: "CUDA 0" }, { value: "cpu", label: "CPU" }]}
              value={device}
              onChange={setDevice}
            />
          </label>
        </div>
        <button className="link-button" onClick={() => setAdvancedOpen((value) => !value)}>
          <Settings2 size={16} />
          <span>{advancedOpen ? "收起高级参数" : "高级参数"}</span>
        </button>
        {advancedOpen ? (
          <div className="advanced-box">
            <label>
              <span>训练模式</span>
              <Select
                options={[{ value: "finetune", label: "基于推荐模型微调" }, { value: "baseline", label: "从 Baseline 开始" }, { value: "resume", label: "继续上次训练" }]}
                defaultValue="finetune"
              />
            </label>
          </div>
        ) : null}
      </section>

      <section className="panel flush">
        <h2>3. 开始训练</h2>
        <button onClick={() => void startTraining()} disabled={!datasetId || busy}>
          <Play size={18} />
          <span>生成训练任务</span>
        </button>
        <p className="helper-text">{message}</p>
      </section>

      <section className="table-band wide-column">
        <h2>任务历史</h2>
        <DataTable<TrainingJob>
          columns={[
            { key: "name", title: "名称", render: (j) => <strong>{j.name}</strong> },
            { key: "status", title: "状态", align: "center", render: (j) => j.status },
            { key: "time", title: "时间", render: (j) => formatBeijingTime(j.ended_at || j.created_at) },
          ]}
          data={jobs}
          rowKey={(j) => j.id}
          emptyText="还没有训练任务"
        />
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
