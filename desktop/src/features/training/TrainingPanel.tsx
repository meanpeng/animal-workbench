import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, Clipboard, Cpu, Database, FolderOpen, Gauge, Layers3, Play, RefreshCw, RotateCw, Server, Square, Wand2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../api";
import { Select } from "../../components/Select";
import type { Dataset, DatasetTrainingSummary, DeviceStatus, ModelItem, ModelProfile, TrainingJob } from "../../types";
import { formatBeijingTime } from "../../utils";
import { buildTrainingModelPayload, useDeviceStatus, useModelProfile, useTrainingJobSSE, useTrainingLog } from "./trainingHooks";

type TrainingMode = "train" | "resume";
type ModelChoice = "yolo8n" | "yolo11n" | "yolo26n" | `model:${number}` | "custom";
type JobFilter = "all" | "running" | "completed" | "failed";
type DetailModal = "dataset" | "device" | "model" | null;

const selectedJobStorageKey = "training:selectedJobId";

export function TrainingPanel({
  datasets,
  jobs,
  models,
  onRefresh,
}: {
  datasets: Dataset[];
  jobs: TrainingJob[];
  models: ModelItem[];
  onRefresh: () => Promise<void>;
}) {
  const [datasetId, setDatasetId] = useState<number | "">(datasets[0]?.id ?? "");
  const [mode, setMode] = useState<TrainingMode>("train");
  const [name, setName] = useState(() => defaultJobName());
  const [modelChoice, setModelChoice] = useState<ModelChoice>("yolo11n");
  const [customModelPath, setCustomModelPath] = useState("");
  const [resumeJobId, setResumeJobId] = useState<number | "">("");
  const [epochs, setEpochs] = useState(50);
  const [imageSize, setImageSize] = useState(960);
  const [batchSize, setBatchSize] = useState(8);
  const [device, setDevice] = useState("auto");
  const deviceStatusHook = useDeviceStatus();
  const [freezeLayers, setFreezeLayers] = useState(0);
  const [lr0, setLr0] = useState("");
  const [patience, setPatience] = useState("");
  const [workers, setWorkers] = useState("");
  const [seed, setSeed] = useState("");
  const [cache, setCache] = useState(false);
  const [augment, setAugment] = useState(true);
  const [optimizer, setOptimizer] = useState("auto");
  const [runYolo, setRunYolo] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("新建任务会先导出 YOLO 数据集；开启真实训练后会调用本机 Ultralytics。");
  const [summary, setSummary] = useState<DatasetTrainingSummary | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(() => Number(localStorage.getItem(selectedJobStorageKey)) || null);
  const [selectedJob, setSelectedJob] = useState<TrainingJob | null>(null);
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const [detailModal, setDetailModal] = useState<DetailModal>(null);

  // Custom hooks for model profile and training log
  const modelProfile = useModelProfile();
  const trainingLog = useTrainingLog(selectedJobId);

  // Shorthand accessors for hook state
  const ds = deviceStatusHook.status;
  const dl = deviceStatusHook.loading;

  const selectedDataset = datasets.find((d) => d.id === Number(datasetId));
  const resumableJobs = useMemo(
    () => jobs.filter((j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled"),
    [jobs],
  );
  const visibleJobs = useMemo(
    () =>
      jobFilter === "all"
        ? jobs
        : jobFilter === "running"
          ? jobs.filter((j) => ["queued", "running"].includes(j.status))
          : jobs.filter((j) => j.status === jobFilter),
    [jobs, jobFilter],
  );
  const readyWarning = summary?.blockers[0] ?? "";
  const gpuBlocked = runYolo && device !== "auto" && device !== "cpu" && ds && !ds.cuda_available;
  const latestJob = jobs[0] ?? null;
  const readinessLevel = readyWarning || gpuBlocked ? "danger" : summary?.warnings.length ? "warning" : "ready";

  // Auto-select first dataset
  useEffect(() => {
    if (!datasetId && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasets, datasetId]);

  // Fetch dataset training summary when dataset changes
  useEffect(() => {
    if (!datasetId) {
      setSummary(null);
      return;
    }
    api.datasetTrainingSummary(Number(datasetId)).then(setSummary).catch((error) => setMessage(error instanceof Error ? error.message : "数据集训练摘要读取失败"));
  }, [datasetId]);

  // Auto-select first resumable job
  useEffect(() => {
    if (mode === "resume" && !resumeJobId && resumableJobs[0]) setResumeJobId(resumableJobs[0].id);
  }, [mode, resumeJobId, resumableJobs]);

  // Refresh model profile when model selection changes
  useEffect(() => {
    const timer = setTimeout(() => void modelProfile.refresh(mode, modelChoice, customModelPath), 250);
    return () => clearTimeout(timer);
  }, [mode, modelChoice, customModelPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selected job from the jobs list
  useEffect(() => {
    setSelectedJob(selectedJobId ? jobs.find((j) => j.id === selectedJobId) ?? null : null);
  }, [jobs, selectedJobId]);

  // Persist selected job id and open SSE + log refresh
  useEffect(() => {
    if (!selectedJobId) return;
    localStorage.setItem(selectedJobStorageKey, String(selectedJobId));
    void refreshJobDetail(selectedJobId);
  }, [selectedJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE for real-time job updates (with reconnect)
  useTrainingJobSSE(
    selectedJobId,
    (job) => setSelectedJob(job),
    (job) => void Promise.all([onRefresh(), trainingLog.refresh(job.id)]),
  );

  // Periodic log refresh for active jobs
  useEffect(() => {
    if (!selectedJobId || !selectedJob) return;
    if (!["queued", "running", "exported"].includes(selectedJob.status)) return;
    const timer = setInterval(() => void trainingLog.refresh(), 5000);
    return () => clearInterval(timer);
  }, [selectedJobId, selectedJob?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshJobDetail(jobId: number | null = selectedJobId) {
    if (!jobId) return;
    const job = await api.trainingJob(jobId);
    setSelectedJob(job);
  }

  async function startTraining() {
    if (!datasetId || readyWarning || gpuBlocked) return;
    if (mode === "resume" && !resumeJobId) {
      setMessage("继续训练需要先选择一个历史任务。");
      return;
    }
    setBusy(true);
    setMessage("正在创建训练任务");
    try {
      const payload = {
        dataset_id: Number(datasetId),
        name: name.trim() || defaultJobName(),
        epochs,
        image_size: imageSize,
        batch_size: batchSize,
        device,
        mode,
        run_yolo: runYolo,
        ...(mode === "resume" ? { resume_job_id: Number(resumeJobId) } : buildTrainingModelPayload(modelChoice, customModelPath)),
        advanced: advancedPayload({ freezeLayers, lr0, patience, workers, seed, cache, augment, optimizer }),
      };
      const job = await api.createTrainingJob(payload);
      setSelectedJobId(job.id);
      await onRefresh();
      setName(defaultJobName());
      setMessage(runYolo ? "训练任务已启动，状态会在详情区实时更新。" : "任务已创建并完成数据集导出。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建训练任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function runJobAction(action: "cancel" | "retry" | "resume", targetJob = selectedJob) {
    if (!targetJob) return;
    setBusy(true);
    try {
      const job =
        action === "cancel"
          ? await api.cancelTrainingJob(targetJob.id)
          : action === "retry"
            ? await api.retryTrainingJob(targetJob.id)
            : await api.resumeTrainingJob(targetJob.id);
      setSelectedJobId(job.id);
      await onRefresh();
      void trainingLog.refresh(job.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务操作失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleJob(jobId: number) {
    if (selectedJobId === jobId) {
      setSelectedJobId(null);
      setSelectedJob(null);
      trainingLog.setText("");
      localStorage.removeItem(selectedJobStorageKey);
      void onRefresh();
      return;
    }
    setSelectedJobId(jobId);
  }

  async function pickCustomModel() {
    try {
      const path = await invoke<string | null>("pick_model_file");
      if (path) setCustomModelPath(path);
    } catch { /* dialog cancelled */ }
  }

  return (
    <section className="training-workspace">
      <section className="training-overview">
        <OverviewStat icon={Database} label="当前数据集" value={selectedDataset?.name ?? "未选择"} tone={readinessLevel} detail={datasetReadinessSummary(summary)} onClick={() => setDetailModal("dataset")} />
        <OverviewStat icon={Cpu} label="训练设备" value={deviceSummary(ds, dl)} detail={device === "auto" ? "自动选择" : device.toUpperCase()} onClick={() => setDetailModal("device")} />
        <OverviewStat icon={Layers3} label="基础模型" value={modelSummary(modelProfile.profile, modelProfile.loading)} detail={mode === "resume" ? "继续历史任务" : "新建训练"} onClick={() => setDetailModal("model")} />
        <OverviewStat icon={Gauge} label="最近任务" value={latestJob ? statusLabel(latestJob.status) : "暂无任务"} detail={latestJob?.name ?? "创建任务后在这里跟踪"} tone={latestJob?.status === "failed" ? "danger" : latestJob?.status === "running" || latestJob?.status === "queued" ? "active" : "ready"} />
      </section>

      <section className="training-config panel">
        <div className="section-heading">
          <h2>启动训练</h2>
          <span>{mode === "resume" ? "继续已有 checkpoint" : "创建新的训练任务"}</span>
        </div>

        <label>
          <span>任务名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>

        <label>
          <span>数据集</span>
          <Select options={[{ value: "", label: "请选择数据集" }, ...datasets.map((d) => ({ value: String(d.id), label: d.name }))]} value={String(datasetId ?? "")} onChange={(value) => setDatasetId(value ? Number(value) : "")} />
        </label>

        <div className="segmented-control" role="radiogroup" aria-label="训练模式">
          <button className={mode === "train" ? "active" : ""} onClick={() => setMode("train")} type="button">新建训练</button>
          <button className={mode === "resume" ? "active" : ""} onClick={() => setMode("resume")} type="button">继续训练</button>
        </div>

        {mode === "train" ? (
          <>
            <label>
              <span>基础模型</span>
              <Select value={modelChoice} onChange={(value) => setModelChoice(value as ModelChoice)} options={[{ value: "yolo8n", label: "YOLO8n" }, { value: "yolo11n", label: "YOLO11n" }, { value: "yolo26n", label: "YOLO26n" }, ...models.map((m) => ({ value: `model:${m.id}`, label: m.name })), { value: "custom", label: "自定义模型" }]} />
            </label>
            {modelChoice === "custom" ? (
              <label>
                <span>选择权重文件</span>
                <div className="inline-control">
                  <input value={customModelPath} readOnly placeholder="点击右侧按钮选择 .pt 文件" />
                  <button className="icon-button" type="button" title="选择文件" onClick={() => void pickCustomModel()}><FolderOpen size={16} /></button>
                  <button className="icon-button" type="button" title="校验权重" onClick={() => void modelProfile.refresh(mode, modelChoice, customModelPath)} disabled={!customModelPath}><RefreshCw size={16} /></button>
                </div>
              </label>
            ) : null}
          </>
        ) : (
          <label>
            <span>历史任务</span>
            <Select value={String(resumeJobId ?? "")} onChange={(value) => setResumeJobId(value ? Number(value) : "")} options={[{ value: "", label: "请选择历史任务" }, ...resumableJobs.map((j) => ({ value: String(j.id), label: `${j.name} · ${statusLabel(j.status)}` }))]} />
          </label>
        )}

        <div className="control-grid training-controls">
          <NumberField label="训练轮数" value={epochs} min={1} max={1000} onChange={setEpochs} disabled={mode === "resume"} />
          <NumberField label="图片尺寸" value={imageSize} min={128} max={2048} onChange={setImageSize} disabled={mode === "resume"} />
          <NumberField label="批大小" value={batchSize} min={1} max={128} onChange={setBatchSize} disabled={mode === "resume"} />
          <label>
            <span>设备</span>
            <Select value={device} onChange={setDevice} options={[{ value: "auto", label: "自动选择" }, { value: "0", label: "CUDA 0" }, { value: "cpu", label: "CPU" }]} />
          </label>
        </div>

        <button className="training-disclosure" type="button" onClick={() => setAdvancedOpen((v) => !v)}>
          <Wand2 size={16} />
          <span>{advancedOpen ? "收起高级参数" : "高级参数"}</span>
        </button>
        {advancedOpen ? (
          <div className="advanced-box training-advanced">
            <NumberField label="冻结层数" value={freezeLayers} min={0} max={500} onChange={setFreezeLayers} disabled={mode === "resume"} />
            <TextField label="lr0" value={lr0} onChange={setLr0} disabled={mode === "resume"} />
            <TextField label="patience" value={patience} onChange={setPatience} disabled={mode === "resume"} />
            <TextField label="workers" value={workers} onChange={setWorkers} />
            <TextField label="seed" value={seed} onChange={setSeed} disabled={mode === "resume"} />
            <label>
              <span>optimizer</span>
              <Select value={optimizer} onChange={setOptimizer} options={["auto", "SGD", "Adam", "AdamW", "NAdam", "RAdam", "RMSProp"].map((v) => ({ value: v, label: v }))} />
            </label>
            <label className="checkbox-row"><input type="checkbox" checked={cache} onChange={(e) => setCache(e.target.checked)} /><span>cache</span></label>
            <label className="checkbox-row"><input type="checkbox" checked={augment} onChange={(e) => setAugment(e.target.checked)} disabled={mode === "resume"} /><span>augment</span></label>
            <label className="checkbox-row"><input type="checkbox" checked={runYolo} onChange={(e) => setRunYolo(e.target.checked)} /><span>调用 Ultralytics 执行真实训练</span></label>
          </div>
        ) : null}

        {readyWarning ? <p className="job-message error">{readyWarning}</p> : null}
        {summary?.warnings.map((w) => <p className="job-message warning" key={w}>{w}</p>)}
        {gpuBlocked ? <p className="job-message error">CUDA 不可用，请改选 CPU 或自动选择。</p> : <p className="helper-text">{message}</p>}
        <button className="save-btn training-primary-action" type="button" disabled={!datasetId || Boolean(readyWarning) || Boolean(gpuBlocked) || busy} onClick={() => void startTraining()}>
          <Play size={18} />
          <span>{runYolo ? "开始训练" : "仅导出数据集"}</span>
        </button>
      </section>

      <section className="training-right-column">
        <section className="table-band training-history">
          <div className="section-heading">
            <h2>训练任务</h2>
            <div className="segmented-control compact" role="radiogroup" aria-label="任务筛选">
              {(["all", "running", "completed", "failed"] as JobFilter[]).map((v) => <button key={v} className={jobFilter === v ? "active" : ""} type="button" onClick={() => setJobFilter(v)}>{filterLabel(v)}</button>)}
            </div>
          </div>
          <div className="training-job-list">
            {visibleJobs.length === 0 ? <p className="empty-line">还没有训练任务</p> : null}
            {visibleJobs.map((job) => {
              const expanded = selectedJobId === job.id;
              const detailJob = selectedJob?.id === job.id ? selectedJob : job;
              return (
                <TrainingJobCard
                  key={job.id}
                  job={detailJob}
                  datasetName={datasetName(datasets, job.dataset_id)}
                  expanded={expanded}
                  logTail={trainingLog.tail}
                  logText={expanded ? trainingLog.text : ""}
                  logLoading={expanded && trainingLog.loading}
                  busy={busy}
                  onToggle={() => toggleJob(job.id)}
                  onTailChange={trainingLog.setTail}
                  onRefresh={() => void refreshJobDetail(job.id)}
                  onCopy={() => void navigator.clipboard.writeText(trainingLog.text)}
                  onCancel={() => void runJobAction("cancel", detailJob)}
                  onRetry={() => void runJobAction("retry", detailJob)}
                  onResume={() => void runJobAction("resume", detailJob)}
                />
              );
            })}
          </div>
        </section>
      </section>
      <TrainingInfoModal kind={detailModal} onClose={() => setDetailModal(null)} summary={summary} deviceStatus={ds} deviceLoading={dl} profile={modelProfile.profile} profileLoading={modelProfile.loading} onRefreshDevice={() => void deviceStatusHook.refresh()} />
    </section>
  );
}

function TrainingJobCard({ job, datasetName, expanded, logTail, logText, logLoading, busy, onToggle, onTailChange, onRefresh, onCopy, onCancel, onRetry, onResume }: { job: TrainingJob; datasetName: string; expanded: boolean; logTail: number; logText: string; logLoading: boolean; busy: boolean; onToggle: () => void; onTailChange: (value: number) => void; onRefresh: () => void; onCopy: () => void; onCancel: () => void; onRetry: () => void; onResume: () => void }) {
  return (
    <article className={expanded ? "training-job-card expanded" : "training-job-card"}>
      <button className="training-job-summary" type="button" onClick={onToggle} aria-expanded={expanded}>
        <div>
          <strong>{job.name}</strong>
          <span>{datasetName} · {formatBeijingTime(job.ended_at || job.created_at)}</span>
        </div>
        <span className="job-status-badge" data-status={job.status}>{statusLabel(job.status)}</span>
        <span className="training-job-progress">{Math.round(job.progress ?? 0)}%</span>
        <ChevronDown className="training-job-chevron" size={17} />
      </button>
      {expanded ? (
        <div className="training-job-expanded">
          <JobDetail job={job} logTail={logTail} logText={logText} logLoading={logLoading} busy={busy} onTailChange={onTailChange} onRefresh={onRefresh} onCopy={onCopy} onCancel={onCancel} onRetry={onRetry} onResume={onResume} />
        </div>
      ) : null}
    </article>
  );
}

function JobDetail({ job, logTail, logText, logLoading, busy, onTailChange, onRefresh, onCopy, onCancel, onRetry, onResume }: { job: TrainingJob | null; logTail: number; logText: string; logLoading: boolean; busy: boolean; onTailChange: (value: number) => void; onRefresh: () => void; onCopy: () => void; onCancel: () => void; onRetry: () => void; onResume: () => void }) {
  if (!job) return <p className="empty-line">点击任务列表中的任务后，这里会显示实时状态、指标和日志。</p>;
  const metrics = job.metrics ?? {};
  return (
    <>
      {job.status === "failed" ? <p className="job-message error">{job.error_summary || "任务失败，请查看日志尾部。"}</p> : null}
      <div className="job-progress-row">
        <span>{statusLabel(job.status)} · {job.stage || "-"}</span>
        <strong>{Math.round(job.progress ?? 0)}%</strong>
      </div>
      <div className="progress-track"><div style={{ width: `${Math.min(100, Math.max(0, job.progress ?? 0))}%` }} /></div>
      <div className="training-stats-grid">
        <Stat icon={Activity} label="Epoch" value={job.current_epoch ? `${job.current_epoch}/${job.total_epochs || "-"}` : "-"} />
        <Stat icon={Server} label="输出目录" value={job.run_dir || "-"} />
        <Stat icon={Database} label="best.pt" value={job.artifact_refs?.best_exists ? "存在" : "未生成"} />
        <Stat icon={Database} label="last.pt" value={job.artifact_refs?.last_exists ? "存在" : "未生成"} />
      </div>
      <div className="training-stats-grid">
        {["precision", "recall", "mAP50", "mAP50-95", "train_loss", "val_loss"].map((key) => <Stat key={key} icon={Layers3} label={key} value={formatMetric(metrics[key])} />)}
      </div>
      <div className="job-actions">
        <button className="link-button" type="button" onClick={onRefresh}><RefreshCw size={16} /><span>刷新日志</span></button>
        <button className="link-button" type="button" onClick={onCopy}><Clipboard size={16} /><span>复制日志</span></button>
        <button className="link-button" type="button" onClick={onRetry} disabled={busy}><RotateCw size={16} /><span>重新训练</span></button>
        <button className="link-button" type="button" onClick={onResume} disabled={busy}><Play size={16} /><span>继续训练</span></button>
        <button className="link-button danger" type="button" onClick={onCancel} disabled={busy || !["queued", "running", "exported"].includes(job.status)}><Square size={16} /><span>取消</span></button>
        <label className="tail-select"><span>最后</span><select value={logTail} onChange={(e) => onTailChange(Number(e.target.value))}>{[100, 200, 500, 1000].map((v) => <option key={v} value={v}>{v} 行</option>)}</select></label>
      </div>
      <pre className="training-log">{logLoading && !logText ? "日志读取中..." : logText || "暂无日志"}</pre>
    </>
  );
}

function TrainingInfoModal({ kind, onClose, summary, deviceStatus, deviceLoading, profile, profileLoading, onRefreshDevice }: { kind: DetailModal; onClose: () => void; summary: DatasetTrainingSummary | null; deviceStatus: DeviceStatus | null; deviceLoading: boolean; profile: ModelProfile | null; profileLoading: boolean; onRefreshDevice: () => void }) {
  if (!kind) return null;
  const title = kind === "dataset" ? "数据集状态" : kind === "device" ? "训练设备" : "基础模型";
  return (
    <div className="modal-overlay" role="presentation">
      <div className="modal-dialog training-info-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="training-modal-header">
          <div>
            <h3>{title}</h3>
            <span>{kind === "dataset" ? datasetReadinessSummary(summary) : kind === "device" ? deviceSummary(deviceStatus, deviceLoading) : modelSummary(profile, profileLoading)}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭"><X size={17} /></button>
        </div>
        {kind === "dataset" ? <DatasetSummaryView summary={summary} /> : null}
        {kind === "device" ? (
          <>
            <button className="link-button" type="button" onClick={onRefreshDevice}><RefreshCw size={16} /><span>刷新设备</span></button>
            <DeviceStatusView status={deviceStatus} loading={deviceLoading} />
          </>
        ) : null}
        {kind === "model" ? <ModelProfileView profile={profile} /> : null}
      </div>
    </div>
  );
}

function OverviewStat({ icon: Icon, label, value, detail, tone = "ready", onClick }: { icon: typeof Cpu; label: string; value: string; detail?: string; tone?: "ready" | "warning" | "danger" | "active"; onClick?: () => void }) {
  const content = (
    <>
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <em>{detail}</em> : null}
      </div>
    </>
  );
  if (onClick) {
    return (
      <button className={`training-overview-card interactive ${tone}`} type="button" onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <article className={`training-overview-card ${tone}`}>
      {content}
    </article>
  );
}

function deviceSummary(status: DeviceStatus | null, loading: boolean) {
  if (loading) return "检测中";
  if (!status) return "未检测";
  if (status.cuda_available || status.torch_available || status.ultralytics_available) return "设备已就绪";
  return "仅 CPU / 待确认";
}

function modelSummary(profile: ModelProfile | null, loading: boolean) {
  if (loading) return "读取中";
  if (!profile) return "待选择";
  if (!profile.ok) return "模型异常";
  return profile.name || "模型已加载";
}

function datasetReadinessSummary(summary: DatasetTrainingSummary | null) {
  if (!summary) return "待读取";
  if (summary.blockers.length > 0) return "需处理";
  if (summary.warnings.length > 0) return "有提醒";
  return "数据集已就绪";
}

function DeviceStatusView({ status, loading }: { status: DeviceStatus | null; loading: boolean }) {
  if (!status) return <p className="empty-line">{loading ? "正在读取设备状态" : "暂无设备状态"}</p>;
  const gpu = status.gpus[0];
  return (
    <div className="device-grid">
      <Stat icon={Cpu} label="CPU" value={`${status.cpu.cores || "-"} 核`} detail={status.cpu.name} />
      <Stat icon={Server} label="内存" value={formatMemory(status.memory.used, status.memory.total)} detail={status.memory.percent == null ? "占用未知" : `${status.memory.percent}% 已用`} />
      <Stat icon={Activity} label="CUDA" value={status.cuda_available ? "可用" : "不可用"} detail={status.torch_available ? "PyTorch 可用" : status.torch_error || "PyTorch 不可用"} />
      <Stat icon={Layers3} label="GPU" value={gpu ? gpu.name : "无可用 GPU"} detail={gpu ? formatGpuMemory(gpu) : "将使用 CPU 或自动选择"} />
      <Stat icon={Server} label="Ultralytics" value={status.ultralytics_available ? "可用" : "不可用"} detail={status.ultralytics_error || "训练后端状态"} />
    </div>
  );
}

function ModelProfileView({ profile }: { profile: ModelProfile | null }) {
  if (!profile) return <p className="empty-line">选择模型后会显示层数、参数量、stride 和权重状态。</p>;
  if (!profile.ok) return <p className="job-message error">{profile.error || "模型结构读取失败"}</p>;
  return (
    <div className="model-profile">
      <strong>{profile.name}</strong>
      <span>{profile.source}</span>
      <div className="training-stats-grid">
        <Stat icon={Layers3} label="层数" value={profile.layer_count ?? "-"} />
        <Stat icon={Activity} label="参数量" value={formatNumber(profile.parameters)} />
        <Stat icon={Cpu} label="stride" value={profile.stride ?? "-"} />
        <Stat icon={Server} label="权重大小" value={profile.weight_file_size ? bytes(profile.weight_file_size) : "-"} />
        <Stat icon={Server} label="任务类型" value={profile.task || profile.model_type} />
        <Stat icon={Database} label="best / last" value={`${profile.best_exists ? "有" : "无"} / ${profile.last_exists ? "有" : "无"}`} />
      </div>
    </div>
  );
}

function DatasetSummaryView({ summary }: { summary: DatasetTrainingSummary | null }) {
  if (!summary) return <p className="empty-line">选择数据集后读取训练摘要。</p>;
  return (
    <>
      <div className="training-stats-grid">
        <Stat icon={Database} label="图片" value={summary.image_count} />
        <Stat icon={Activity} label="标注框" value={summary.annotation_count} />
        <Stat icon={Layers3} label="类别" value={summary.class_count} />
        <Stat icon={Server} label="空标签图片" value={summary.empty_label_images} />
      </div>
      <div className="split-row">
        <span>train {summary.splits.train}</span>
        <span>val {summary.splits.val}</span>
        <span>test {summary.splits.test}</span>
        <span>未分配 {summary.splits.unassigned}</span>
      </div>
    </>
  );
}

function Stat({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string | number; detail?: string }) {
  return (
    <div className="training-stat">
      <Icon size={17} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <em>{detail}</em> : null}
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}

function TextField({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return <label><span>{label}</span><input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></label>;
}

function advancedPayload(values: { freezeLayers: number; lr0: string; patience: string; workers: string; seed: string; cache: boolean; augment: boolean; optimizer: string }) {
  const result: Record<string, unknown> = {
    freeze_layers: Math.max(0, values.freezeLayers),
    cache: values.cache,
    augment: values.augment,
  };
  for (const key of ["lr0", "patience", "workers", "seed"] as const) {
    if (values[key]) result[key] = Number(values[key]);
  }
  if (values.optimizer && values.optimizer !== "auto") {
    result.optimizer = values.optimizer;
  }
  return result;
}

function datasetName(datasets: Dataset[], datasetId: number) {
  return datasets.find((d) => d.id === datasetId)?.name ?? `#${datasetId}`;
}

function statusLabel(status: TrainingJob["status"]) {
  return { queued: "排队中", exported: "已导出", running: "训练中", completed: "已完成", failed: "失败", cancelled: "已取消" }[status];
}

function filterLabel(filter: JobFilter) {
  return { all: "全部", running: "训练中", completed: "已完成", failed: "失败" }[filter];
}

function defaultJobName() {
  return `动物检测训练 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
}

function formatNumber(value: number | null) {
  if (value == null) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatMetric(value: unknown) {
  return typeof value === "number" ? value.toFixed(4) : value ? String(value) : "-";
}

function formatMemory(used?: number | null, total?: number | null) {
  if (!total) return "未知";
  return `${bytes(used ?? 0)} / ${bytes(total)}`;
}

function formatGpuMemory(gpu: DeviceStatus["gpus"][number]) {
  const used = gpu.used_memory ?? gpu.reserved_memory ?? gpu.allocated_memory ?? 0;
  return `${bytes(used)} / ${bytes(gpu.total_memory)}`;
}

function bytes(value: number) {
  if (!value) return "0.0 GB";
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
