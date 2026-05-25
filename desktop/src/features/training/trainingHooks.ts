import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { DeviceStatus, ModelProfile, TrainingJob, TrainingLog } from "../../types";

// ── useDeviceStatus ──────────────────────────────────────────────────

export function useDeviceStatus(pollInterval = 10_000) {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

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
    void refresh(true);
    const timer = setInterval(() => void refresh(false), pollInterval);

    const onHidden = () => {
      if (document.hidden) clearInterval(timer);
    };
    const onVisible = () => {
      if (!document.hidden) void refresh(false);
    };
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, pollInterval]);

  return { status, loading, refresh };
}

// ── useModelProfile ──────────────────────────────────────────────────

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
        let result: ModelProfile;
        if (modelChoice.startsWith("model:")) {
          result = await api.modelProfile({ model_id: Number(modelChoice.slice("model:".length)) });
        } else {
          result = await api.modelProfile({
            model_path: modelChoice === "default" ? "yolo11n.pt" : customModelPath,
          });
        }
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
