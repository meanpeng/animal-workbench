from __future__ import annotations

import json
import shutil
import time

from fastapi.testclient import TestClient
from PIL import Image

from animal_workbench.main import app
from animal_workbench.services.annotation_parsers import parse_dataset_folder


def make_image(path, size=(100, 80)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color=(30, 90, 120)).save(path)


def test_parse_yolo_coco_and_voc_minimal_datasets(tmp_path):
    yolo = tmp_path / "yolo"
    make_image(yolo / "images" / "train" / "a.jpg")
    (yolo / "labels" / "train").mkdir(parents=True)
    (yolo / "labels" / "train" / "a.txt").write_text("0 0.5 0.5 0.2 0.4\n", encoding="utf-8")
    (yolo / "dataset.yaml").write_text("path: .\ntrain: images/train\nnames: [animal]\n", encoding="utf-8")
    parsed_yolo = parse_dataset_folder(yolo)
    assert parsed_yolo is not None
    assert parsed_yolo.format == "yolo"
    assert parsed_yolo.samples[0].boxes[0].x == 0.4

    coco = tmp_path / "coco"
    make_image(coco / "images" / "b.jpg")
    (coco / "annotations.json").write_text(
        json.dumps(
            {
                "images": [{"id": 1, "file_name": "images/b.jpg", "width": 100, "height": 80}],
                "categories": [{"id": 7, "name": "deer"}],
                "annotations": [{"id": 1, "image_id": 1, "category_id": 7, "bbox": [10, 20, 30, 40]}],
            }
        ),
        encoding="utf-8",
    )
    parsed_coco = parse_dataset_folder(coco)
    assert parsed_coco is not None
    assert parsed_coco.format == "coco"
    assert parsed_coco.samples[0].boxes[0].width == 0.3

    voc = tmp_path / "voc"
    make_image(voc / "JPEGImages" / "c.jpg")
    (voc / "Annotations").mkdir(parents=True)
    (voc / "Annotations" / "c.xml").write_text(
        """
        <annotation>
          <filename>c.jpg</filename>
          <size><width>100</width><height>80</height></size>
          <object><name>boar</name><bndbox><xmin>10</xmin><ymin>20</ymin><xmax>50</xmax><ymax>60</ymax></bndbox></object>
        </annotation>
        """,
        encoding="utf-8",
    )
    parsed_voc = parse_dataset_folder(voc)
    assert parsed_voc is not None
    assert parsed_voc.format == "voc"
    assert parsed_voc.samples[0].boxes[0].height == 0.5


def test_folder_import_job_reports_progress_and_imports_annotations(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source = tmp_path / "source-yolo"
    make_image(source / "images" / "train" / "animal.jpg")
    (source / "labels" / "train").mkdir(parents=True)
    (source / "labels" / "train" / "animal.txt").write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")
    (source / "dataset.yaml").write_text("path: .\ntrain: images/train\nnames: [animal]\n", encoding="utf-8")

    with TestClient(app) as client:
        created = client.post(
            "/dataset-jobs/import-folder",
            json={"path": str(source), "name": "job yolo", "dataset_kind": "auto"},
        )
        assert created.status_code == 200
        job_id = created.json()["id"]

        job = None
        for _ in range(50):
            job = client.get(f"/dataset-jobs/{job_id}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.05)

        assert job is not None
        assert job["status"] == "completed"
        assert job["stage"] == "completed"
        assert job["percent"] == 100
        summary = json.loads(job["result_summary"])
        assert summary["annotation_count"] == 1

        datasets = client.get("/datasets").json()
        assert datasets[0]["name"] == "job yolo"
        media = client.get("/media").json()
        annotations = client.get(f"/media/{media[0]['id']}/annotations").json()
        assert len(annotations["annotations"]) == 1
        batches = client.get("/annotation-batches").json()
        assert batches[0]["completed_items"] == 1
        assert batches[0]["total_items"] == 1
        assert batches[0]["status"] == "completed"

        shutil.rmtree(source)
        content = client.get(f"/media/{media[0]['id']}/content")
        assert content.status_code == 200


def test_folder_import_can_link_to_existing_dataset_and_deduplicates_annotations(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source = tmp_path / "source-yolo"
    make_image(source / "images" / "train" / "animal.jpg")
    (source / "labels" / "train").mkdir(parents=True)
    (source / "labels" / "train" / "animal.txt").write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")
    (source / "dataset.yaml").write_text("path: .\ntrain: images/train\nnames: [animal]\n", encoding="utf-8")

    with TestClient(app) as client:
        dataset = client.post(
            "/datasets",
            json={"name": "existing", "dataset_type": "user", "media_asset_ids": []},
        ).json()

        first = client.post(
            "/dataset-jobs/import-folder",
            json={
                "path": str(source),
                "name": "job yolo",
                "dataset_kind": "auto",
                "target_dataset": {"mode": "existing", "dataset_id": dataset["id"]},
            },
        )
        assert first.status_code == 200
        first_job_id = first.json()["id"]
        first_job = None
        for _ in range(50):
            first_job = client.get(f"/dataset-jobs/{first_job_id}").json()
            if first_job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.05)
        assert first_job["status"] == "completed"
        first_summary = json.loads(first_job["result_summary"])
        assert first_summary["linked_media_count"] == 1
        assert first_summary["annotation_count"] == 1

        second = client.post(
            "/dataset-jobs/import-folder",
            json={
                "path": str(source),
                "name": "job yolo",
                "dataset_kind": "auto",
                "target_dataset": {"mode": "existing", "dataset_id": dataset["id"]},
            },
        )
        second_job_id = second.json()["id"]
        second_job = None
        for _ in range(50):
            second_job = client.get(f"/dataset-jobs/{second_job_id}").json()
            if second_job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.05)
        assert second_job["status"] == "completed"
        second_summary = json.loads(second_job["result_summary"])
        assert second_summary["annotation_count"] == 0
        assert second_summary["skipped_duplicate_annotations"] == 1

        detail = client.get(f"/datasets/{dataset['id']}/media").json()
        assert detail["stats"]["total_media"] == 1
        media_id = detail["media"][0]["id"]
        annotations = client.get(f"/media/{media_id}/annotations").json()
        assert len(annotations["annotations"]) == 1
