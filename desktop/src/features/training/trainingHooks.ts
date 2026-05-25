import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { DeviceStatus, ModelProfile, TrainingJob, TrainingLog } from "../../types";

// ── useDeviceStatus ──────────────────────────────────────────────────

export function useDeviceStatus(pollInterval = 10_000) {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const result = await api.trainingDeviceStatus();
      if (mountedRef.current) setStatus(result);
    } catch {
      // keep previous status on error
    } finally {
      if (showLoading && mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    const stopPolling = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const startPolling = () => {
      stopPolling();
      if (!document.hidden) {
        timerRef.current = setInterval(() => void refresh(false), pollInterval);
      }
    };

    void refresh(true);
    startPolling();

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
        return;
      }
      void refresh(false);
      startPolling();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mountedRef.current = false;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, pollInterval]);

  return { status, loading, refresh };
}

// ── useModelProfile ──────────────────────────────────────────────────

export const MODEL_FILES: Record<string, string> = {
  yolo8n: "yolo8n.pt",
  yolo11n: "yolo11n.pt",
  yolo26n: "yolo26n.pt",
};

export function resolveTrainingModelPath(modelChoice: string, customModelPath: string) {
  if (modelChoice === "custom") return customModelPath;
  return MODEL_FILES[modelChoice] ?? "yolo11n.pt";
}

function selectedModelId(modelChoice: string) {
  if (!modelChoice.startsWith("model:")) return null;
  return Number(modelChoice.slice("model:".length));
}

export function buildTrainingModelPayload(modelChoice: string, customModelPath: string) {
  const modelId = selectedModelId(modelChoice);
  if (modelId != null) return { base_model_id: modelId };
  return { base_model_path: resolveTrainingModelPath(modelChoice, customModelPath) };
}

function buildModelProfilePayload(modelChoice: string, customModelPath: string) {
  const modelId = selectedModelId(modelChoice);
  if (modelId != null) return { model_id: modelId };
  return { model_path: resolveTrainingModelPath(modelChoice, customModelPath) };
}

export function useModelProfile() {
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(
    async (mode: string, modelChoice: string, customModelPath: string) => {
      if (mode === "resume") {
        setProfile(null);
        return;
      }
      setLoading(true);
      try {
        const result: ModelProfile = await api.modelProfile(buildModelProfilePayload(modelChoice, customModelPath));
        setProfile(result);
      } catch (error) {
        setProfile({
          ok: false,
          name: "模型读取失败",
          source: "",
          model_type: "unknown",
          layer_count: null,
          parameters: null,
          trainable_parameters: null,
          error: error instanceof Error ? error.message : "模型读取失败",
        });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { profile, loading, refresh };
}

// ── useTrainingLog ───────────────────────────────────────────────────

export function useTrainingLog(jobId: number | null, defaultTail = 200) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [tail, setTail] = useState(defaultTail);

  const refresh = useCallback(
    async (id: number | null = jobId, t = tail) => {
      if (!id) return;
      setLoading(true);
      try {
        const log: TrainingLog = await api.trainingJobLog(id, t);
        setText(log.text || "");
      } catch (error) {
        setText(error instanceof Error ? error.message : "日志读取失败");
      } finally {
        setLoading(false);
      }
    },
    [jobId, tail],
  );

  // Re-fetch when jobId or tail changes
  useEffect(() => {
    if (jobId) void refresh(jobId, tail);
  }, [jobId, tail]); // eslint-disable-line react-hooks/exhaustive-deps

  return { text, setText, loading, tail, setTail, refresh };
}

// ── useTrainingJobSSE ────────────────────────────────────────────────

export function useTrainingJobSSE(
  jobId: number | null,
  onUpdate: (job: TrainingJob) => void,
  onDone: (job: TrainingJob) => void,
) {
  const mountedRef = useRef(true);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    mountedRef.current = true;
    if (!jobId) return;

    let es: EventSource | null = null;

    function connect() {
      if (!mountedRef.current || !jobId) return;
      es = new EventSource(api.trainingJobEventsUrl(jobId));

      es.onmessage = (event) => {
        const job: TrainingJob = JSON.parse(event.data);
        onUpdate(job);
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          onDone(job);
          es?.close();
        }
      };

      es.onerror = () => {
        es?.close();
        // Reconnect with backoff if still mounted
        if (mountedRef.current) {
          reconnectRef.current = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      es?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps
}
