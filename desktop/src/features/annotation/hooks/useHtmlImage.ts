import { useEffect, useState } from "react";
import { getCachedImage, loadImage } from "../imageCache";

export function useHtmlImage(mediaId: number | null) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (mediaId === null) {
      setImage(null);
      return;
    }

    const cached = getCachedImage(mediaId);
    if (cached) {
      setImage(cached);
      return;
    }

    let cancelled = false;
    loadImage(mediaId)
      .then((next) => {
        if (!cancelled) setImage(next);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load image for media", mediaId, err);
      });

    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  return image;
}
