import hashlib
import json

import pytest
from test_publication import bundle
from test_storage import png

from interface_api.export import export_example


def test_export_immutable_hash_and_missing_asset_fails_before_package(repo, tmp_path):
    life, source, artifact, validation = bundle(repo, tmp_path)
    life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    data = png()
    sha = hashlib.sha256(data).hexdigest()
    ident = "test-image"
    repo.event(
        source["run_id"],
        "test_evidence",
        assets=[
            {
                "asset_id": ident,
                "kind": "post_tool_screenshot",
                "object_key": "v1/runs/test/image.png",
                "mime_type": "image/png",
                "sha256": sha,
                "byte_size": len(data),
                "width": 2,
                "height": 2,
                "captured_at": source["created_at"],
                "label": "Synthetic fixture",
                "result": None,
                "detail": None,
            }
        ],
    )

    class Missing:
        def get_png(self, *args):
            raise ValueError("Missing object")

    with pytest.raises(ValueError):
        export_example(
            repo, Missing(), source["run_id"], [], tmp_path / "missing", True
        )
    assert not (tmp_path / "missing").exists()

    class Stored:
        def get_png(self, key, digest):
            assert digest == sha
            return data

    manifest = export_example(
        repo, Stored(), source["run_id"], [], tmp_path / "example", True
    )
    assert manifest["definition_sha256"] == artifact["definition_sha256"]
    for name, digest in manifest["files"].items():
        assert (
            hashlib.sha256((tmp_path / "example" / name).read_bytes()).hexdigest()
            == digest
        )
    assert (tmp_path / "example" / manifest["export_path"][ident]).read_bytes() == data
    assert (
        json.loads((tmp_path / "example" / "artifact.json").read_text())["definition"]
        == artifact["definition"]
    )
