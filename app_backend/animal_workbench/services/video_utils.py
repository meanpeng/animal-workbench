from __future__ import annotations

import tempfile
from pathlib import Path

import cv2

MAX_FRAMES = 60


def extract_video_frames(
    video_path: Path,
    *,
    output_dir: Path | None = None,
    base_name: str | None = None,
) -> list[Path]:
    """Extract evenly spaced JPEG frames, capped at MAX_FRAMES.

    The default cadence is about 1 fps. Longer videos increase the interval so
    the saved frames stay under the cap while remaining evenly distributed.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        cap.release()
        return []

    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if fps <= 0 or total_frames <= 0:
            return []

        # Estimate the number of frames needed at 1 fps.
        duration_sec = total_frames / fps
        needed = int(duration_sec)

        if needed <= 0:
            return []

        # Increase the interval when the 1 fps estimate exceeds the cap.
        if needed > MAX_FRAMES:
            interval_frames = int(total_frames / MAX_FRAMES)
        else:
            interval_frames = int(fps)

        if interval_frames < 1:
            interval_frames = 1

        out_dir = output_dir or Path(tempfile.mkdtemp(prefix="video_frames_"))
        out_dir.mkdir(parents=True, exist_ok=True)

        name = base_name or video_path.stem
        frames: list[Path] = []
        frame_idx = 0
        saved = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % interval_frames == 0:
                if saved >= MAX_FRAMES:
                    break
                out_path = out_dir / f"{name}_frame_{saved + 1:04d}.jpg"
                cv2.imwrite(str(out_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
                frames.append(out_path)
                saved += 1

            frame_idx += 1

        return frames
    finally:
        cap.release()
