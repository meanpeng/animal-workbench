from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from animal_workbench.config import get_paths
from animal_workbench.main import app


def _dataset_with_class(client: TestClient, media_id: int) -> tuple[int, int]:
    dataset = client.post(
        "/datasets",
        json={"name": f"dataset-{media_id}", "dataset_type": "user", "media_asset_ids": [media_id]},
    ).json()
    created_class = client.post(
        f"/datasets/{dataset['id']}/classes",
        json={"name": f"animal_{media_id}", "display_name": f"Animal {media_id}"},
    ).json()
    return dataset["id"], created_class["id"]


def test_health_and_summary(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path))
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True

        summary = client.get("/summary")
        assert summary.status_code == 200
        body = summary.json()
        assert body["project"]["id"] > 0
        assert "counts" in body


def test_tauri_path_import_flow_serves_managed_media(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    image_path = source_dir / "camera one.jpg"
    Image.new("RGB", (80, 60), color=(20, 80, 120)).save(image_path)

    with TestClient(app) as client:
        response = client.post(
            "/media/import",
            json={"paths": [str(image_path)], "batch_name": "desktop import batch"},
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["imported"]) == 1
        assert body["imported"][0]["width"] == 80
        assert body["batch"]["name"] == "desktop import batch"

        media_id = body["imported"][0]["id"]
        internal_path = Path(body["imported"][0]["internal_path"]).resolve()
        media_dir = get_paths().media_dir.resolve()
        internal_path.relative_to(media_dir)
        assert internal_path.exists()
        assert internal_path != image_path.resolve()

        image_path.unlink()
        content = client.get(f"/media/{media_id}/content")
        assert content.status_code == 200
        assert content.headers["content-type"].startswith("image/")


def test_annotation_update_and_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    image_path = source_dir / "camera one.jpg"
    Image.new("RGB", (80, 60), color=(20, 80, 120)).save(image_path)

    with TestClient(app) as client:
        imported = client.post("/media/import", json={"paths": [str(image_path)]}).json()
        media_id = imported["imported"][0]["id"]
        dataset_id, class_id = _dataset_with_class(client, media_id)

        created = client.post(
            "/annotations",
            json={
                "dataset_id": dataset_id,
                "media_asset_id": media_id,
                "class_id": class_id,
                "x": 0.1,
                "y": 0.2,
                "width": 0.3,
                "height": 0.4,
                "review_status": "draft",
            },
        )
        assert created.status_code == 200
        annotation_id = created.json()["id"]

        updated = client.put(
            f"/annotations/{annotation_id}",
            json={
                "dataset_id": dataset_id,
                "class_id": class_id,
                "x": 0.2,
                "y": 0.25,
                "width": 0.2,
                "height": 0.3,
                "review_status": "confirmed",
            },
        )
        assert updated.status_code == 200
        assert updated.json()["x"] == 0.2
        assert updated.json()["review_status"] == "confirmed"

        deleted = client.delete(f"/annotations/{annotation_id}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] == annotation_id

        listing = client.get(f"/media/{media_id}/annotations?dataset_id={dataset_id}")
        assert listing.status_code == 200
        assert listing.json()["annotations"] == []


def test_summary_counts_only_existing_dataset_media(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    image_path = source_dir / "camera one.jpg"
    Image.new("RGB", (80, 60), color=(20, 80, 120)).save(image_path)

    with TestClient(app) as client:
        imported = client.post("/media/import", json={"paths": [str(image_path)], "batch_name": "stale batch"}).json()
        media_id = imported["imported"][0]["id"]
        empty_summary = client.get("/summary").json()
        assert empty_summary["counts"]["media_assets"] == 0

        dataset_id, class_id = _dataset_with_class(client, media_id)
        client.post(
            "/annotations",
            json={
                "dataset_id": dataset_id,
                "media_asset_id": media_id,
                "class_id": class_id,
                "x": 0.1,
                "y": 0.2,
                "width": 0.3,
                "height": 0.4,
                "review_status": "confirmed",
            },
        )

        populated_summary = client.get("/summary").json()
        assert populated_summary["counts"]["media_assets"] == 1
        assert populated_summary["counts"]["annotations"] == 1

        deleted = client.delete(f"/datasets/{dataset_id}")
        assert deleted.status_code == 200
        deleted_summary = client.get("/summary").json()
        assert deleted_summary["counts"]["media_assets"] == 0
        assert deleted_summary["counts"]["annotations"] == 0


def test_create_dataset_class_and_reject_duplicate(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    with TestClient(app) as client:
        dataset = client.post("/datasets", json={"name": "labels", "dataset_type": "user", "media_asset_ids": []}).json()
        created = client.post(f"/datasets/{dataset['id']}/classes", json={"name": "red_fox", "display_name": "red fox"})
        assert created.status_code == 200
        assert created.json()["display_name"] == "red fox"

        duplicate = client.post(f"/datasets/{dataset['id']}/classes", json={"name": "red_fox", "display_name": "red fox 2"})
        assert duplicate.status_code == 409


def test_annotation_rejects_out_of_bounds_box(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    image_path = source_dir / "camera one.jpg"
    Image.new("RGB", (80, 60), color=(20, 80, 120)).save(image_path)

    with TestClient(app) as client:
        imported = client.post("/media/import", json={"paths": [str(image_path)]}).json()
        media_id = imported["imported"][0]["id"]
        dataset_id, class_id = _dataset_with_class(client, media_id)

        created = client.post(
            "/annotations",
            json={
                "dataset_id": dataset_id,
                "media_asset_id": media_id,
                "class_id": class_id,
                "x": 0.8,
                "y": 0.2,
                "width": 0.3,
                "height": 0.4,
                "review_status": "draft",
            },
        )
        assert created.status_code == 422


def test_bulk_annotation_save_is_transactional(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    image_path = source_dir / "camera one.jpg"
    Image.new("RGB", (80, 60), color=(20, 80, 120)).save(image_path)

    with TestClient(app) as client:
        imported = client.post("/media/import", json={"paths": [str(image_path)], "batch_name": "bulk batch"}).json()
        media_id = imported["imported"][0]["id"]
        dataset_id, class_id = _dataset_with_class(client, media_id)

        saved = client.post(
            f"/media/{media_id}/annotations/bulk?dataset_id={dataset_id}",
            json={
                "upserts": [
                    {"class_id": class_id, "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2, "review_status": "confirmed"}
                ],
                "delete_ids": [],
            },
        )
        assert saved.status_code == 200
        annotation_id = saved.json()["annotations"][0]["id"]

        failed = client.post(
            f"/media/{media_id}/annotations/bulk?dataset_id={dataset_id}",
            json={
                "upserts": [
                    {"id": annotation_id, "class_id": 9999, "x": 0.2, "y": 0.2, "width": 0.2, "height": 0.2, "review_status": "confirmed"}
                ],
                "delete_ids": [annotation_id],
            },
        )
        assert failed.status_code == 422

        listing = client.get(f"/media/{media_id}/annotations?dataset_id={dataset_id}").json()
        assert len(listing["annotations"]) == 1
        assert listing["annotations"][0]["id"] == annotation_id

        detail = client.get(f"/datasets/{dataset_id}/media").json()
        assert detail["stats"]["total_annotations"] == 1
        assert detail["stats"]["annotated_media"] == 1

        datasets = client.get("/datasets").json()
        stats = json.loads(next(item for item in datasets if item["id"] == dataset_id)["sample_stats"])
        assert stats["annotation_count"] == 1
        assert stats["annotated_media"] == 1

        batches = client.get("/annotation-batches").json()
        assert batches[0]["completed_items"] == 1
        assert batches[0]["status"] == "completed"

        removed = client.post(
            f"/media/{media_id}/annotations/bulk?dataset_id={dataset_id}",
            json={"upserts": [], "delete_ids": [annotation_id]},
        )
        assert removed.status_code == 200
        assert removed.json()["annotations"] == []

        detail = client.get(f"/datasets/{dataset_id}/media").json()
        assert detail["media"][0]["annotation_status"] == "unannotated"
        assert detail["media"][0]["annotation_count"] == 0
        assert detail["stats"]["total_annotations"] == 0
        assert detail["stats"]["annotated_media"] == 0

        datasets = client.get("/datasets").json()
        stats = json.loads(next(item for item in datasets if item["id"] == dataset_id)["sample_stats"])
        assert stats["annotation_count"] == 0
        assert stats["annotated_media"] == 0

        batches = client.get("/annotation-batches").json()
        assert batches[0]["completed_items"] == 0
        assert batches[0]["status"] == "open"


def test_create_fusion_dataset_from_existing_datasets(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    image_a = source_dir / "a.jpg"
    image_b = source_dir / "b.jpg"
    Image.new("RGB", (80, 60), color=(20, 80, 120)).save(image_a)
    Image.new("RGB", (60, 40), color=(120, 80, 20)).save(image_b)

    with TestClient(app) as client:
        imported = client.post("/media/import", json={"paths": [str(image_a), str(image_b)]}).json()
        media_a = imported["imported"][0]["id"]
        media_b = imported["imported"][1]["id"]
        ds_a = client.post("/datasets", json={"name": "a", "dataset_type": "user", "media_asset_ids": [media_a]}).json()
        ds_b = client.post("/datasets", json={"name": "b", "dataset_type": "user", "media_asset_ids": [media_a, media_b]}).json()

        created = client.post(
            "/datasets/fusion",
            json={"name": "fusion", "source_dataset_ids": [ds_a["id"], ds_b["id"]]},
        )
        assert created.status_code == 200
        assert created.json()["dataset_type"] == "fusion"

        detail = client.get(f"/datasets/{created.json()['id']}/media").json()
        assert detail["total"] == 2


def test_delete_public_dataset_removes_managed_materialized_cache_only(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    paths = get_paths()
    managed = paths.public_data_dir / "swg" / "materialized_yolo"
    managed.mkdir(parents=True)
    (managed / "dataset.yaml").write_text("names: []\n", encoding="utf-8")

    external = tmp_path / "external" / "materialized_yolo"
    external.mkdir(parents=True)
    (external / "keep.txt").write_text("keep", encoding="utf-8")

    with TestClient(app) as client:
        dataset = client.post(
            "/datasets",
            json={
                "name": "managed public",
                "dataset_type": "public",
                "media_asset_ids": [],
                "composition_rule": {"source_path": str(managed)},
            },
        ).json()
        deleted = client.delete(f"/datasets/{dataset['id']}")
        assert deleted.status_code == 200
        assert not managed.exists()

        dataset = client.post(
            "/datasets",
            json={
                "name": "external public",
                "dataset_type": "public",
                "media_asset_ids": [],
                "composition_rule": {"source_path": str(external)},
            },
        ).json()
        deleted = client.delete(f"/datasets/{dataset['id']}")
        assert deleted.status_code == 200
        assert external.exists()
        assert (external / "keep.txt").exists()
