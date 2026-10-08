from interface_api.reads import Reads


def test_hidden_wait_completion_counts_once_without_claiming_dispatch():
    class Repo:
        def rows(self, *args):
            return [
                {"type": "wait_condition_satisfied", "step_id": "wait", "payload": {}},
                {"type": "wait_condition_satisfied", "step_id": "wait", "payload": {}},
                {"type": "tool_finished", "step_id": "read", "payload": {"dispatch_state": "completed"}},
                {"type": "tool_finished", "step_id": "failed", "payload": {"dispatch_state": "uncertain"}},
            ]

        def get(self, *args):
            return {"definition": {"steps": [{}, {}, {}]}}

    result = Reads(Repo()).run({"run_id": "test", "pinned_artifact_id": "artifact", "last_event_sequence": 4})
    assert result["progress"]["completed_steps"] == 2
