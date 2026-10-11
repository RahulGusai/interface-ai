import pytest
from conftest import deployment
from pydantic import ValidationError

from interface_api.dto import (
    DiscoveryStart,
    InvokeRequest,
    ReplayStart,
    ValidateRequest,
)


@pytest.mark.parametrize(
    "dto", [DiscoveryStart, ReplayStart, ValidateRequest, InvokeRequest]
)
def test_policy_defaults_and_validation(dto):
    data = {"app_deployment_id": "00000000-0000-4000-8000-000000000001", "inputs": {}}
    if dto == DiscoveryStart:
        data.update(kind="discovery", task="search")
    if dto == ReplayStart:
        data.update(kind="replay", artifact_id="00000000-0000-4000-8000-000000000002")
    assert dto(**data).model_dump()["access_policy"] == "READ_ONLY"
    assert dto(**data, access_policy="READ_WRITE").access_policy == "READ_WRITE"
    with pytest.raises(ValidationError):
        dto(**data, access_policy="ADMIN")


def test_policy_persists_and_database_rejects_invalid(repo):
    dep = deployment(repo)
    with repo.db.transaction() as conn:
        row = repo.new_run(conn, dep, task="Search", access_policy="READ_WRITE")
    assert repo.get("runs", "run_id", row["run_id"])["access_policy"] == "READ_WRITE"
    with repo.db.transaction() as conn:
        default = repo.new_run(conn, dep, task="Search")
    assert default["access_policy"] == "READ_ONLY"
    with pytest.raises(Exception):
        with repo.db.transaction() as conn:
            repo.new_run(conn, dep, task="Search", access_policy="ADMIN")


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["ACCESS_POLICY_VIOLATION", "DOMAIN_POLICY_VIOLATION"])
async def test_discovery_failure_retains_policy_code_and_never_creates_artifact(
    repo, tmp_path, code
):
    from conftest import run

    from interface_api.config import Settings
    from interface_api.lifecycle import Lifecycle

    row = run(repo)
    repo.transition(row["run_id"], "running")

    class Violation:
        settings = Settings(repo_root=tmp_path, _env_file=None)

        async def execute_raw(self, ident):
            return {
                "runtime_result": {
                    "status": "policy_blocked",
                    "summary": "Denied",
                    "error": {"code": code, "message": "Denied"},
                },
                "discovery_artifact": {"untrusted": True},
            }

    await Lifecycle(repo, Violation(), None).execute(row["run_id"])
    failed = repo.get("runs", "run_id", row["run_id"])
    assert failed["status"] == "failed"
    assert failed["result"]["outcome"]["code"] == code
    assert repo.rows("artifacts") == []
