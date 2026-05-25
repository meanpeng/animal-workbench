import { useEffect, useState } from "react";
import { api } from "../../../api";

export function DatasetThumbs({ datasetId, sampleStats }: { datasetId: number; sampleStats: string }) {
  const [urls, setUrls] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let mediaCount = 0;
        try {
          const stats = JSON.parse(sampleStats || "{}");
          mediaCount = stats.media_count || 0;
        } catch {
          // Ignore malformed sample stats; thumbnails are only decorative context.
        }
        const limit = 4;
        const offset = mediaCount > limit
          ? Math.floor(Math.random() * (mediaCount - limit))
          : 0;
        const result = await api.datasetMedia(datasetId, { limit, offset });
        if (cancelled) return;
        setUrls(result.media.map((m) => api.mediaContentUrl(m.id)));
      } catch (e) {
        if (!cancelled) {
          console.error("DatasetThumbs load failed for dataset", datasetId, e);
          setUrls([]);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [datasetId, sampleStats]);

  return (
    <div className="dataset-select-thumbs">
      {urls && urls.length > 0 ? (
        urls.map((url, i) => (
          <img key={i} src={url} alt="" className="dataset-select-thumb" />
        ))
      ) : (
        <span className="dataset-select-thumb-placeholder">
          {urls === null ? "⏳" : "🖼"}
        </span>
      )}
    </div>
  );
}
