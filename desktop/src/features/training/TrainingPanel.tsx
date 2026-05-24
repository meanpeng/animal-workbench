import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, Database, Layers3, Play, RefreshCw, Server, Settings2 } from "lucide-react";
import { api } from "../../api";
import { DataTable } from "../../components/DataTable";
import { Select } from "../../components/Select";
import type { Dataset, DeviceStatus, ModelItem, ModelProfile, TrainingJob } from "../../types";
import { formatBeijingTime } from "../../utils";

type TrainingMode = "train" | "resume";
type ModelChoice = "default" | `model:${number}` | "custom";

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
  const [name, setName] = useState(defaultJobName());
  const [modelChoice, setModelChoice] = useState<ModelChoice>("default");
  const [customModelPath, setCustomModelPath] = useState("yolo11n.pt");
  const [resumeJobId, setResumeJobId] = useState<number | "">("");
  const [epochs, setEpochs] = useState(50);
  const [imageSize, setImageSize] = useState(960);
  const [batchSize, setBatchSize] = useState(8);
  const [device, setDevice] = useState("auto");
  const [freezeLayers, setFreezeLayers] = useState(0);
  const [runYolo, setRunYolo] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("新建任务会先导出 YOLO 数据集；开启真实训练后会调用本机 Ultralytics。");
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const selectedDataset = datasets.find((dataset) => dataset.id === Number(datasetId));
  const selectedStats = useMemo(() => parseDatasetStats(selectedDataset), [selectedDataset]);
  const resumableJobs = jobs.filter((job) => job.status === "completed" || job.status === "running" || job.status === "failed");

  useEffect(() => {
    if (!datasetId && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasets, datasetId]);

  useEffect(() => {
    void refreshDeviceStatus();
  }, []);

  useEffect(() => {
    if (mode === "resume" && !resumeJobId && resumableJobs[0]) {
      setResumeJobId(resumableJobs[0].id);
    }
  }, [mode, resumeJobId, resumableJobs]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshModelProfile();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [modelChoice, customModelPath]);

  const readyWarning = trainingReadyWarning(selectedStats);

  async function refreshDeviceStatus() {
    setDeviceLoading(true);
    try {
      setDeviceStatus(await api.trainingDeviceStatus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设备状态读取失败");
    } finally {
      setDeviceLoading(false);
    }
  }

  async function refreshModelProfile() {
    if (mode === "resume") {
      setProfile(null);
      return;
    }
    setProfileLoading(true);
    try {
      if (modelChoice.startsWith("model:")) {
        setProfile(await api.modelProfile({ model_id: Number(modelChoice.slice("model:".length)) }));
      } else {
        setProfile(await api.modelProfile({ model_path: modelChoice === "default" ? "yolo11n.pt" : customModelPath }));
      }
    } catch (error) {
      setProfile({
        ok: false,
        name: "模型结构读取失败",
        source: "",
        model_type: "unknown",
        layer_count: null,
        parameters: null,
        trainable_parameters: null,
        error: error instanceof Error ? error.message : "模型结构读取失败",
      });
    } finally {
      setProfileLoading(false);
    }
  }

  async function startTraining() {
    if (!datasetId || readyWarning) return;
    if (mode === "resume" && !resumeJobId) {
      setMessage("继续训练需要先选择一个历史训练任务。");
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
        ...(mode === "resume" ? { resume_job_id: Number(resumeJobId) } : modelPayload(modelChoice, customModelPath)),
        advanced: {
          freeze_layers: Math.max(0, freezeLayers),
        },
      };
      await api.createTrainingJob(payload);
      await onRefresh();
      setName(defaultJobName());
      setMessage(runYolo ? "训练任务已启动，任务状态会在历史列表中更新。" : "任务已创建并开始导出 YOLO 数据集。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建训练任务失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="training-workspace">
      <section className="training-config panel">
        <div className="section-heading">
          <h2>训练配置</h2>
          <span>{selectedDataset?.name ?? "未选择数据集"}</span>
        </div>

        <label>
          <span>任务名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>

        <label>
          <span>数据集</span>
          <Select
            options={[{ value: "", label: "请选择数据集" }, ...datasets.map((dataset) => ({ value: String(dataset.id), label: dataset.name }))]}
            value={String(datasetId ?? "")}
            onChange={(value) => setDatasetId(value ? Number(value) : "")}
          />
        </label>

        <div className="segmented-control" role="radiogroup" aria-label="训练模式">
          <button className={mode === "train" ? "active" : ""} onClick={() => setMode("train")} type="button">
            新建训练
          </button>
          <button className={mode === "resume" ? "active" : ""} onClick={() => setMode("resume")} type="button">
            继续训练
          </button>
        </div>

        {mode === "train" ? (
          <>
            <label>
              <span>基础模型</span>
              <Select
                value={modelChoice}
                onChange={(value) => setModelChoice(value as ModelChoice)}
                options={[
                  { value: "default", label: "YOLO 默认模型 yolo11n.pt" },
                  ...models.map((model) => ({ value: `model:${model.id}`, label: model.name })),
                  { value: "custom", label: "自定义权重路径" },
                ]}
              />
            </label>
            {modelChoice === "custom" ? (
              <label>
                <span>权重路径或模型名</span>
                <input value={customModelPath} onChange={(event) => setCustomModelPath(event.target.value)} />
              </label>
            ) : null}
          </>
        ) : (
          <label>
            <span>继续训练任务</span>
            <Select
              value={String(resumeJobId ?? "")}
              onChange={(value) => setResumeJobId(value ? Number(value) : "")}
              options={[
                { value: "", label: "请选择历史任务" },
                ...resumableJobs.map((job) => ({ value: String(job.id), label: `${job.name} · ${statusLabel(job.status)}` })),
              ]}
            />
          </label>
        )}

        <div className="control-grid training-controls">
          <label>
            <span>训练轮数</span>
            <input type="number" min={1} max={1000} value={epochs} onChange={(event) => setEpochs(Number(event.target.value))} />
          </label>
          <label>
            <span>图片尺寸</span>
            <input type="number" min={128} max={2048} value={imageSize} onChange={(event) => setImageSize(Number(event.target.value))} />
          </label>
          <label>
            <span>批大小</span>
            <input type="number" min={1} max={128} value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} />
          </label>
          <label>
            <span>设备</span>
            <Select
              value={device}
              onChange={setDevice}
              options={[
                { value: "auto", label: "自动选择" },
                { value: "0", label: "CUDA 0" },
                { value: "cpu", label: "CPU" },
              ]}
            />
          </label>
        </div>

        <button className="link-button" type="button" onClick={() => setAdvancedOpen((value) => !value)}>
          <Settings2 size={16} />
          <span>{advancedOpen ? "收起高级参数" : "高级参数"}</span>
        </button>
        {advancedOpen ? (
          <div className="advanced-box training-advanced">
            <label>
              <span>冻结层数</span>
              <input
                type="number"
                min={0}
                max={500}
                value={freezeLayers}
                onChange={(event) => setFreezeLayers(Number(event.target.value))}
                disabled={mode === "resume"}
              />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={runYolo} onChange={(event) => setRunYolo(event.target.checked)} />
              <span>调用 Ultralytics 执行真实训练</span>
            </label>
          </div>
        ) : null}

        {readyWarning ? <p className="job-message error">{readyWarning}</p> : <p className="helper-text">{message}</p>}
        <button className="save-btn" type="button" disabled={!datasetId || Boolean(readyWarning) || busy} onClick={() => void startTraining()}>
          <Play size={18} />
          <span>{runYolo ? "开始训练" : "导出训练数据"}</span>
        </button>
      </section>

      <section className="training-main">
        <section className="panel">
          <div className="section-heading">
            <h2>设备状态</h2>
            <button className="icon-button" type="button" onClick={() => void refreshDeviceStatus()} title="刷新设备状态">
              <RefreshCw size={16} />
            </button>
          </div>
          <DeviceStatusView status={deviceStatus} loading={deviceLoading} />
        </section>

        <section className="panel">
          <div className="section-heading">
            <h2>模型结构</h2>
            <span>{profileLoading ? "读取中" : profile?.ok ? "已加载" : "待确认"}</span>
          </div>
          <ModelProfileView profile={profile} />
        </section>

        <section className="panel">
          <h2>数据集就绪状态</h2>
          <div className="training-stats-grid">
            <Stat icon={Database} label="图片" value={selectedStats.totalMedia} />
            <Stat icon={Activity} label="已标注" value={selectedStats.annotatedMedia} />
            <Stat icon={Layers3} label="类别" value={selectedStats.classCount} />
            <Stat icon={Server} label="标注框" value={selectedStats.totalAnnotations} />
          </div>
        </section>
      </section>

      <section className="table-band training-history">
        <h2>训练任务</h2>
        <DataTable<TrainingJob>
          columns={[
            { key: "name", title: "名称", render: (job) => <strong>{job.name}</strong> },
            { key: "status", title: "状态", align: "center", render: (job) => <span className="job-status-badge">{statusLabel(job.status)}</span> },
            { key: "dataset", title: "数据集", render: (job) => datasetName(datasets, job.dataset_id) },
            { key: "time", title: "时间", render: (job) => formatBeijingTime(job.ended_at || job.created_at) },
            { key: "error", title: "说明", render: (job) => job.error_message || job.runtime_dataset_path || "-" },
          ]}
          data={jobs}
          rowKey={(job) => job.id}
          emptyText="还没有训练任务"
        />
      </section>
    </section>
  );
}

function DeviceStatusView({ status, loading }: { status: DeviceStatus | null; loading: boolean }) {
  if (!status) return <p className="empty-line">{loading ? "正在读取设备状态" : "暂无设备状态"}</p>;
  const gpu = status.gpus[0];
  return (
    <div className="device-grid">
      <Stat icon={Cpu} label="CPU" value={`${status.cpu.cores || "-"} 核`} detail={status.cpu.name} />
      <Stat icon={Server} label="内存" value={formatMemory(status.memory.used, status.memory.total)} detail={status.memory.percent == null ? "占用未知" : `${status.memory.percent}% 已用`} />
      <Stat icon={Activity} label="CUDA" value={status.cuda_available ? "已检测到" : "未检测到"} detail={status.torch_available ? "PyTorch 可用" : status.torch_error || "PyTorch 不可用"} />
      <Stat icon={Layers3} label="GPU" value={gpu ? gpu.name : "无可用 GPU"} detail={gpu ? formatGpuMemory(gpu) : "将使用 CPU 或自动选择"} />
      <Stat icon={Server} label="Ultralytics" value={status.ultralytics_available ? "可用" : "不可用"} detail={status.ultralytics_error || "训练后端状态"} />
    </div>
  );
}

function ModelProfileView({ profile }: { profile: ModelProfile | null }) {
  if (!profile) return <p className="empty-line">选择模型后会显示层数、参数量和可训练参数。</p>;
  if (!profile.ok) return <p className="job-message error">{profile.error || "模型结构读取失败"}</p>;
  return (
    <div className="model-profile">
      <strong>{profile.name}</strong>
      <span>{profile.source}</span>
      <div className="training-stats-grid">
        <Stat icon={Layers3} label="层数" value={profile.layer_count ?? "-"} />
        <Stat icon={Activity} label="参数量" value={formatNumber(profile.parameters)} />
        <Stat icon={Cpu} label="可训练参数" value={formatNumber(profile.trainable_parameters)} />
        <Stat icon={Server} label="类型" value={profile.model_type} />
      </div>
    </div>
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

function modelPayload(modelChoice: ModelChoice, customModelPath: string) {
  if (modelChoice.startsWith("model:")) return { base_model_id: Number(modelChoice.slice("model:".length)) };
  return { base_model_path: modelChoice === "default" ? "yolo11n.pt" : customModelPath };
}

function parseDatasetStats(dataset?: Dataset) {
  const fallback = { totalMedia: 0, annotatedMedia: 0, totalAnnotations: 0, classCount: 0 };
  if (!dataset) return fallback;
  try {
    const stats = JSON.parse(dataset.sample_stats || "{}");
    return {
      totalMedia: Number(stats.total_media ?? stats.total_images ?? stats.image_count ?? 0),
      annotatedMedia: Number(stats.annotated_media ?? 0),
      totalAnnotations: Number(stats.total_annotations ?? stats.annotation_count ?? 0),
      classCount: Number(stats.class_count ?? 0),
    };
  } catch {
    return fallback;
  }
}

function trainingReadyWarning(stats: ReturnType<typeof parseDatasetStats>) {
  if (stats.totalMedia <= 0) return "当前数据集没有可训练图片。";
  if (stats.classCount <= 0) return "当前数据集还没有类别。";
  if (stats.totalAnnotations <= 0) return "当前数据集还没有标注框。";
  return "";
}

function datasetName(datasets: Dataset[], datasetId: number) {
  return datasets.find((dataset) => dataset.id === datasetId)?.name ?? `#${datasetId}`;
}

function statusLabel(status: TrainingJob["status"]) {
  return {
    queued: "排队中",
    exported: "已导出",
    running: "训练中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status];
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

function formatMemory(used?: number | null, total?: number | null) {
  if (!total) return "未知";
  return `${bytes(used ?? 0)} / ${bytes(total)}`;
}

function formatGpuMemory(gpu: DeviceStatus["gpus"][number]) {
  const used = gpu.used_memory ?? gpu.reserved_memory ?? gpu.allocated_memory ?? 0;
  return `${bytes(used)} / ${bytes(gpu.total_memory)}`;
}

function bytes(value: number) {
  if (!value) return "0 GB";
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
