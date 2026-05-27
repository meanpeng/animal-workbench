import { api } from "../../api";

const imageCache = new Map<number, HTMLImageElement>();
const imageRequests = new Map<number, Promise<HTMLImageElement>>();
const prefetchQueue = new Map<number, () => Promise<void>>();
const MAX_CACHED_IMAGES = 16;
const MAX_PREFETCHING_IMAGES = 2;
let activePrefetches = 0;
let prefetchTimer: number | null = null;

function cacheImage(mediaId: number, image: HTMLImageElement): void {
  if (imageCache.has(mediaId)) imageCache.delete(mediaId);
  while (imageCache.size >= MAX_CACHED_IMAGES) {
    const firstKey = imageCache.keys().next().value;
    if (firstKey === undefined) break;
    imageCache.delete(firstKey);
  }
  imageCache.set(mediaId, image);
}

export function loadImage(mediaId: number): Promise<HTMLImageElement> {
  const cached = imageCache.get(mediaId);
  if (cached) {
    cacheImage(mediaId, cached);
    return Promise.resolve(cached);
  }

  const existingRequest = imageRequests.get(mediaId);
  if (existingRequest) return existingRequest;

  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new window.Image();
    img.decoding = "async";
    img.onload = () => {
      cacheImage(mediaId, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Image load failed for media ${mediaId}`));
    img.src = api.mediaContentUrl(mediaId);
  }).finally(() => {
    imageRequests.delete(mediaId);
  });

  imageRequests.set(mediaId, request);
  return request;
}

function schedulePrefetchQueue(): void {
  if (prefetchTimer !== null) return;
  const run = () => {
    prefetchTimer = null;
    while (activePrefetches < MAX_PREFETCHING_IMAGES && prefetchQueue.size > 0) {
      const entry = prefetchQueue.entries().next().value;
      if (!entry) break;
      const [mediaId, task] = entry as [number, () => Promise<void>];
      prefetchQueue.delete(mediaId);
      activePrefetches += 1;
      task()
        .catch(() => {
          // Prefetch is opportunistic; failed images will be retried when selected.
        })
        .finally(() => {
          activePrefetches -= 1;
          schedulePrefetchQueue();
        });
    }
  };

  const requestIdle = (window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;
  prefetchTimer = requestIdle ? requestIdle(run, { timeout: 300 }) : window.setTimeout(run, 120);
}

export function prefetchImage(mediaId: number): void {
  if (imageCache.has(mediaId) || imageRequests.has(mediaId) || prefetchQueue.has(mediaId)) return;
  prefetchQueue.set(mediaId, () => loadImage(mediaId).then(() => undefined));
  schedulePrefetchQueue();
}

export function getCachedImage(mediaId: number): HTMLImageElement | undefined {
  const cached = imageCache.get(mediaId);
  if (cached) {
    cacheImage(mediaId, cached);
  }
  return cached;
}
