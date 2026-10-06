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
