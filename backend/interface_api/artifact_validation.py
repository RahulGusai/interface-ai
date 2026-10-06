import copy
import hashlib
import json
import re

from jsonschema import Draft202012Validator, FormatChecker

TOOLS = {
    "observe_ui",
    "navigate",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "select_option",
    "wait_for",
    "check_ui",
    "extract_data",
}
FORBIDDEN = {
    "observation_id",
    "control_ref",
    "tool_call_id",
    "source_tool_call_id",
    "call_id",
    "x",
    "y",
}


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate_schema(schema):
    if (
        not isinstance(schema, dict)
        or schema.get("type") != "object"
        or schema.get("additionalProperties") is not False
    ):
        raise ValueError("SCHEMA_UNSUPPORTED: expected closed flat object")
    if set(schema) - {
        "$schema",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "description",
    }:
        raise ValueError("SCHEMA_UNSUPPORTED")
    props = schema.get("properties", {})
    if (
        not isinstance(props, dict)
        or not isinstance(schema.get("required", []), list)
        or set(schema.get("required", [])) - set(props)
    ):
        raise ValueError("SCHEMA_UNSUPPORTED")
    for name, field in props.items():
        if (
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
            or not isinstance(field, dict)
            or field.get("type") not in ("string", "number", "boolean")
        ):
            raise ValueError("SCHEMA_UNSUPPORTED")
        if set(field) - {
            "type",
            "description",
            "enum",
            "format",
            "minimum",
            "maximum",
            "default",
        } or field.get("format") not in (None, "email"):
            raise ValueError("SCHEMA_UNSUPPORTED")
    Draft202012Validator.check_schema(schema)
    for field in props.values():
        if "default" in field:
            Draft202012Validator(field, format_checker=FormatChecker()).validate(
                field["default"]
            )


def validate_inputs(schema, values):
    validate_schema(schema)
    if not isinstance(values, dict):
        raise ValueError("INPUT_CONTRACT_INVALID")
    result = copy.deepcopy(values)
    for name, field in schema.get("properties", {}).items():
        if name not in result and "default" in field:
            result[name] = copy.deepcopy(field["default"])
    errors = list(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(result)
    )
    if errors:
        raise ValueError("INPUT_CONTRACT_INVALID")
    canonical(result)
    return result


def validate_definition(definition):
    from pathlib import Path

    schema = json.loads(
        (
            Path(__file__).resolve().parents[2] / "contracts/artifact.schema.json"
        ).read_text()
    )
    if list(Draft202012Validator(schema).iter_errors(definition)):
        raise ValueError("ARTIFACT_CONTRACT_INVALID")
    validate_schema(definition["input_schema"])
    validate_schema(definition["output_schema"])
    seen = set()
    checks = set()

    def walk(value, allowed):
        if isinstance(value, list):
            for item in value:
                walk(item, allowed)
        elif isinstance(value, dict):
            if set(value) & FORBIDDEN:
                raise ValueError("Transient identifiers/recorded coordinates forbidden")
            kind = value.get("kind")
            if (
                kind == "input"
                and value["path"] not in definition["input_schema"]["properties"]
            ):
                raise ValueError("Undeclared input binding")
            if kind == "step_output" and value["step_id"] not in allowed:
                raise ValueError("Forward or invalid step binding")
            if kind == "url" and (
                "\\" in value["path"]
                or ".." in value["path"]
                or value["path"].startswith("//")
            ):
                raise ValueError("Invalid relative URL")
            if (
                kind == "literal"
                and isinstance(value.get("value"), str)
                and re.match(r"https?://", value["value"], re.IGNORECASE)
            ):
                raise ValueError("Tenant URL literal forbidden")
            if value.get("check_id"):
                if value["check_id"] in checks:
                    raise ValueError("Duplicate check")
                checks.add(value["check_id"])
                if value.get("step_id") and value["step_id"] not in allowed:
                    raise ValueError("Forward check")
            for item in value.values():
                walk(item, allowed)

    if definition["entry"]["url"]["kind"] not in ("environment", "url"):
        raise ValueError("Untrusted entry")
    walk(definition["entry"], seen)

    def step(s):
        if s["step_id"] in seen:
            raise ValueError("Duplicate step")
        walk(s["arguments"], seen)
        walk(s.get("target"), seen)
        walk(s.get("pre_checks", []), seen)
        seen.add(s["step_id"])
        walk(s.get("post_checks", []), seen)

    for s in definition["steps"]:
        step(s)
        for recovery in s.get("recoveries", []):
            if recovery["on_check_id"] not in {
                c["check_id"]
                for c in s.get("pre_checks", []) + s.get("post_checks", [])
            }:
                raise ValueError("Unknown recovery check")
            if recovery["kind"] == "saved_action":
                step(recovery["step"])
                walk(recovery["then_checks"], seen)
    walk(definition["success_checks"], seen)
    walk(definition["output_mapping"], seen)
    if set(definition["output_mapping"]) != set(
        definition["output_schema"]["properties"]
    ):
        raise ValueError("Output mapping must cover declared outputs")
    for outcome in definition["business_outcomes"]:
        if outcome["after_step_id"] not in seen:
            raise ValueError("Invalid business outcome position")
        walk(outcome, seen)
    canonical(definition)
    return definition
