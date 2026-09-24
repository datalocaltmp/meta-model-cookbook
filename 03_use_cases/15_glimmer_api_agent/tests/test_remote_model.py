"""Tests for the remote-model plugin: the approval gate call and the handler.

No network and no Hermes install needed; a stand-in replaces Hermes' approval
module. Run from the recipe directory:

    pip install -r requirements.txt
    pytest tests
"""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

PLUGIN = Path(__file__).resolve().parents[1] / "remote-model" / "__init__.py"


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("remote_model", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "LEDGER", str(tmp_path / "egress.jsonl"))
    return module


class FakeGate:
    """Stands in for Hermes' tools.approval; records each prompt and answers it."""

    def __init__(self, verdict=None, error=None):
        self.prompts = []
        self._verdict = verdict or {"approved": True, "message": None}
        self._error = error

    def request_tool_approval(self, tool_name, reason, *, rule_key=""):
        self.prompts.append({"tool": tool_name, "text": reason, "rule_key": rule_key})
        if self._error:
            raise self._error
        return self._verdict


@pytest.fixture
def gate(monkeypatch):
    """Install an approving gate; tests swap in their own with install_gate."""
    return install_gate(monkeypatch, FakeGate())


def install_gate(monkeypatch, fake):
    tools = ModuleType("tools")
    approval = ModuleType("tools.approval")
    approval.request_tool_approval = fake.request_tool_approval
    tools.approval = approval
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.approval", approval)
    return fake


class FakeClient:
    """Stands in for OpenAI(); records the request and returns a canned answer."""

    def __init__(self, answer="42", error=None):
        self.calls = []
        self._answer = answer
        self._error = error
        self.responses = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return SimpleNamespace(output_text=self._answer)


@pytest.fixture
def client(plugin, monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(plugin, "_client", lambda: fake)
    return fake


def ledger_rows(plugin):
    path = Path(plugin.LEDGER)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def call(plugin, question, reason="needs specifics"):
    return json.loads(plugin._handler({"question": question, "reason": reason}))


# What the user sees is what is sent


def test_the_approved_text_is_the_sent_text(plugin, gate, client):
    question = "How does the US wash sale rule adjust cost basis?"
    call(plugin, question, reason="tax specifics")

    [prompt] = gate.prompts
    [request] = client.calls
    assert request == {"model": plugin.MODEL, "input": question}
    assert f"\n    {request['input']}\n" in prompt["text"]
    assert f"{len(question.encode())} bytes" in prompt["text"]
    assert "tax specifics" in prompt["text"]
    assert plugin.MODEL in prompt["text"]


def test_nothing_is_sent_before_the_gate_answers(plugin, monkeypatch, client):
    def gate_that_checks(tool_name, reason, *, rule_key=""):
        assert client.calls == []
        return {"approved": True}

    install_gate(monkeypatch, SimpleNamespace(request_tool_approval=gate_that_checks))
    assert call(plugin, "q?")["success"] is True


def test_rule_key_is_scoped_to_the_text(plugin, gate, client):
    call(plugin, "question one")
    call(plugin, "question one")
    call(plugin, "question two")
    keys = [p["rule_key"] for p in gate.prompts]
    assert keys[0] == keys[1] != keys[2]
    assert keys[0].startswith("remote_model:")


@pytest.mark.parametrize("question", ["", "   ", None, 42])
def test_a_missing_question_never_reaches_the_gate(plugin, gate, client, question):
    assert call(plugin, question)["success"] is False
    assert gate.prompts == [] and client.calls == []


# Refusals fail closed, and a denial invites a rewrite


def test_a_denial_with_feedback_invites_a_rewrite(plugin, monkeypatch, client):
    verdict = {"approved": False, "outcome": "denied", "deny_reason": "drop the state name"}
    install_gate(monkeypatch, FakeGate(verdict))

    result = call(plugin, "What are Ohio's rules on X?")

    assert result["success"] is False
    assert client.calls == []
    assert "drop the state name" in result["error"]
    assert f"call {plugin.TOOL} again" in result["error"]


@pytest.mark.parametrize(
    "verdict",
    [
        {"approved": False, "outcome": "timeout", "message": "BLOCKED: timed out."},
        {"approved": False, "message": "BLOCKED: no interactive user."},
    ],
)
def test_a_timeout_or_block_sends_nothing_and_does_not_invite_a_retry(
    plugin, monkeypatch, client, verdict
):
    install_gate(monkeypatch, FakeGate(verdict))
    result = call(plugin, "q?")
    assert result["success"] is False
    assert client.calls == []
    assert "Nothing was sent" in result["error"]
    assert "again" not in result["error"]


def test_a_failing_gate_sends_nothing(plugin, monkeypatch, client):
    install_gate(monkeypatch, FakeGate(error=RuntimeError("gate down")))
    assert call(plugin, "q?")["success"] is False
    assert client.calls == []


def test_outside_hermes_the_gate_is_missing_and_nothing_is_sent(plugin, monkeypatch, client):
    monkeypatch.setitem(sys.modules, "tools", None)
    assert call(plugin, "q?")["success"] is False
    assert client.calls == []


# The ledger and the remote call


def test_ledger_records_metadata_never_content(plugin, gate, monkeypatch):
    monkeypatch.setattr(plugin, "_client", lambda: FakeClient(answer="secret answer"))
    question = "a distinctive question"
    call(plugin, question, reason="a distinctive reason")

    [row] = ledger_rows(plugin)
    assert row["event"] == "sent"
    assert row["bytes"] == len(question.encode())
    assert row["digest"] == plugin._digest(question)
    assert row["model"] == plugin.MODEL
    raw = Path(plugin.LEDGER).read_text()
    for secret in (question, "secret answer", "a distinctive reason"):
        assert secret not in raw


def test_a_refusal_is_logged_without_content(plugin, monkeypatch, client):
    install_gate(monkeypatch, FakeGate({"approved": False, "outcome": "denied"}))
    call(plugin, "a distinctive question")
    [row] = ledger_rows(plugin)
    assert row["event"] == "not sent" and row["outcome"] == "denied"
    assert "a distinctive question" not in Path(plugin.LEDGER).read_text()


def test_handler_reports_a_remote_failure(plugin, gate, monkeypatch):
    error = RuntimeError("upstream said no to: a distinctive question")
    monkeypatch.setattr(plugin, "_client", lambda: FakeClient(error=error))

    result = call(plugin, "a distinctive question")

    assert result["success"] is False
    [row] = ledger_rows(plugin)
    assert row["event"] == "remote error"
    assert row["error"] == "RuntimeError"
    assert "a distinctive question" not in Path(plugin.LEDGER).read_text()


def test_missing_key_fails_closed(plugin, gate, monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    assert call(plugin, "q?")["success"] is False


# Registration


def test_register_wires_only_the_tool(plugin):
    ctx = SimpleNamespace(tools=[])
    ctx.register_tool = lambda **kw: ctx.tools.append(kw)

    plugin.register(ctx)

    [tool] = ctx.tools
    assert tool["name"] == plugin.TOOL
    assert tool["handler"] is plugin._handler
    # The model supplies only the question and a reason, never a destination.
    assert set(tool["schema"]["parameters"]["properties"]) == {"question", "reason"}
