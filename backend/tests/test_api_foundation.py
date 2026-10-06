from fastapi.testclient import TestClient


def make_client(tmp_path):
    from interface_api.config import Settings
    from interface_api.main import create_app

    settings = Settings(
        repo_root=tmp_path,
        INTERFACE_CORS_ORIGINS=["https://console.example"],
        _env_file=None,
    )
    return TestClient(create_app(settings))


def test_health_deployment_cas_and_catalog(tmp_path):
    with make_client(tmp_path) as client:
        assert client.get("/health/live").json() == {"status": "alive"}
        assert client.get("/v1/capabilities").json()["items"] == []
        data = {
            "tenant_id": "t",
            "product_id": "memberdesk",
            "base_url": "http://localhost:4173",
            "environment": "demo",
            "ui_variant": "standard-v1",
        }
        created = client.post("/v1/app-deployments", json=data)
        assert created.status_code == 201
        deployment = created.json()
        assert deployment["config_version"] == 1
        ident = deployment["app_deployment_id"]
        assert client.get(f"/v1/app-deployments/{ident}/bindings").json()["items"] == []
        update = client.patch(
            f"/v1/app-deployments/{ident}",
            json={"expected_config_version": 1, "ui_variant": "v2"},
        )
        assert update.json()["config_version"] == 2
        assert update.json()["app_deployment_id"] == ident
        assert (
            client.patch(
                f"/v1/app-deployments/{ident}",
                json={"expected_config_version": 1, "ui_variant": "v3"},
            ).status_code
            == 409
        )
        assert client.get("/v1/app-deployments/missing").status_code == 404
        assert client.get("/health/ready").json()["storage"] == "unavailable"
    with make_client(tmp_path) as client:
        assert client.get("/v1/app-deployments").json()["total"] == 1


def test_cors_and_url_validation(tmp_path):
    with make_client(tmp_path) as client:
        headers = {
            "Origin": "https://console.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Idempotency-Key,Content-Type",
        }
        assert (
            client.options("/v1/runs", headers=headers).headers[
                "access-control-allow-origin"
            ]
            == "https://console.example"
        )
        headers["Origin"] = "https://unrelated.example"
        assert (
            "access-control-allow-origin"
            not in client.options("/v1/runs", headers=headers).headers
        )
        data = {
            "tenant_id": "t",
            "product_id": "p",
            "base_url": "https://user:secret@example.com",
            "environment": "demo",
            "ui_variant": "v",
        }
        response = client.post("/v1/app-deployments", json=data)
        assert response.status_code == 422
        assert "secret" not in response.text
