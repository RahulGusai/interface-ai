import pytest

from interface_api.bridge import validate_message


def test_rejects_malformed_version_run_order_and_metadata():
    good = {
        "protocol_version": 1,
        "run_id": "r",
        "type": "event",
        "message_seq": 1,
        "event": {"type": "tool_started", "step_id": None, "payload": {}},
        "assets": [],
    }
    assert validate_message(good, "r", 1) == good
    for change in (
        {"protocol_version": 2},
        {"run_id": "other"},
        {"message_seq": 3},
        {"type": "bogus"},
        {"assets": [{"staged_path": "../x"}]},
    ):
        with pytest.raises(ValueError):
            validate_message({**good, **change}, "r", 1)
