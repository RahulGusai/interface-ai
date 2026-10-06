import pytest


def test_schema_contract_validation_and_typed_defaults():
    from interface_api.artifact_validation import validate_inputs, validate_schema

    schema = {
        "type": "object",
        "properties": {
            "amount": {"type": "number", "minimum": 0},
            "enabled": {"type": "boolean", "default": True},
        },
        "required": ["amount"],
        "additionalProperties": False,
    }
    validate_schema(schema)
    assert validate_inputs(schema, {"amount": 3}) == {"amount": 3, "enabled": True}
    with pytest.raises(ValueError):
        validate_inputs(schema, {"amount": "3"})
    with pytest.raises(ValueError):
        validate_schema(
            {
                "type": "object",
                "properties": {"x": {"$ref": "https://example.com"}},
                "additionalProperties": False,
            }
        )


def test_artifact_rejects_transient_ids_and_forward_bindings():
    from interface_api.artifact_validation import validate_definition

    base = {
        "surface": "browser",
        "compatibility": {"product_id": "p", "ui_variant": "v", "vendor_release": None},
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        "entry": {"url": {"kind": "environment", "path": "base_url"}, "checks": []},
        "steps": [
            {
                "step_id": "s1",
                "tool": "observe_ui",
                "arguments": {"mode": {"kind": "literal", "value": "both"}},
                "pre_checks": [],
                "post_checks": [],
                "recoveries": [],
            }
        ],
        "success_checks": [
            {
                "check_id": "ok",
                "kind": "tool_status_equals",
                "step_id": "s1",
                "expected": "ok",
            }
        ],
        "business_outcomes": [],
        "output_mapping": {},
    }
    assert validate_definition(base) == base
    import copy

    stale = copy.deepcopy(base)
    stale["steps"][0]["arguments"]["observation_id"] = {
        "kind": "literal",
        "value": "old",
    }
    with pytest.raises(ValueError, match="Transient"):
        validate_definition(stale)
    forward = copy.deepcopy(base)
    forward["steps"][0]["arguments"]["text"] = {
        "kind": "step_output",
        "step_id": "s2",
        "path": "text",
    }
    with pytest.raises(ValueError, match="Forward"):
        validate_definition(forward)


def test_email_and_business_refs_match_runtime_contract():
    import copy

    from test_publication import DEFINITION

    from interface_api.artifact_validation import validate_definition, validate_inputs

    for email in ("a@b", "a b@example.test"):
        with pytest.raises(ValueError):
            validate_inputs(DEFINITION["input_schema"], {"email": email})
    bad = copy.deepcopy(DEFINITION)
    bad["business_outcomes"][0]["checks"] = [
        {
            "check_id": "future",
            "kind": "field_equals",
            "actual": {
                "kind": "step_output",
                "step_id": "s004",
                "path": "fields.status.value",
            },
            "expected": {"kind": "literal", "value": "Active"},
        }
    ]
    with pytest.raises(ValueError, match="Forward"):
        validate_definition(bad)


def test_navigation_requires_trusted_url_binding():
    import copy

    from test_publication import DEFINITION

    from interface_api.artifact_validation import validate_definition

    bad = copy.deepcopy(DEFINITION)
    bad["steps"][0] = {
        "step_id": "s001",
        "tool": "navigate",
        "arguments": {"url": "http://tenant.example/members"},
        "pre_checks": [],
        "post_checks": [],
        "recoveries": [],
    }
    with pytest.raises(ValueError):
        validate_definition(bad)


def test_shared_email_acceptance_cases_and_defaults():
    import json
    from pathlib import Path

    from interface_api.artifact_validation import validate_inputs

    cases = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "contracts/value-validation-cases.json"
        ).read_text()
    )
    schema = {
        "type": "object",
        "properties": {"email": {"type": "string", "format": "email"}},
        "required": ["email"],
        "additionalProperties": False,
    }
    for case in cases:
        if case["valid"]:
            assert (
                validate_inputs(schema, {"email": case["value"]})["email"]
                == case["value"]
            )
            assert (
                validate_inputs(
                    {
                        **schema,
                        "properties": {
                            "email": {
                                **schema["properties"]["email"],
                                "default": case["value"],
                            }
                        },
                    },
                    {},
                )["email"]
                == case["value"]
            )
        else:
            with pytest.raises(ValueError):
                validate_inputs(schema, {"email": case["value"]})
