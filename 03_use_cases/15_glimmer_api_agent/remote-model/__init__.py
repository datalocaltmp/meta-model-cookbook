"""consult_remote_model: Muse Spark behind Hermes' human-approval gate.

The handler asks Hermes' own approval gate, the one that guards dangerous shell
commands, before it sends anything. The approval text and the request are built
from the same string, so what the user approves is byte for byte what leaves.
Denial, timeout, and a missing or failing gate all fail closed.

The destination lives in the environment, never in the tool's arguments, so the
model can't choose where its question goes:

    MODEL_API_KEY          required, your Meta Model API key
    REMOTE_MODEL_BASE_URL  default https://api.meta.ai/v1
    REMOTE_MODEL_NAME      default muse-spark-1.3
"""

import hashlib
import json
import os
import time

from openai import OpenAI

TOOLSET = "remote_model"
TOOL = "consult_remote_model"

BASE_URL = os.environ.get("REMOTE_MODEL_BASE_URL", "https://api.meta.ai/v1")
MODEL = os.environ.get("REMOTE_MODEL_NAME", "muse-spark-1.3")
LEDGER = os.path.join(
    os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")), "egress.jsonl"
)

SCHEMA = {
    "name": TOOL,
    "description": (
        "Ask a more capable remote model a self-contained question. Use when the task "
        "needs current information, specialist domain knowledge, or reasoning beyond "
        "local capability. The question must stand alone: no names, account numbers, "
        "filenames, amounts, or other specifics from the user's documents. State the "
        "general form of the problem. The user reviews the exact text and must approve "
        "before anything is sent. If the user asks for changes, rewrite the question "
        "and call this tool again."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "Self-contained question"},
            "reason": {
                "type": "string",
                "description": "Why local capability is insufficient",
            },
        },
        "required": ["question", "reason"],
    },
}


def _digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _ledger(**row):
    """Append one metadata row. Never the question, never the answer."""
    row["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        with open(LEDGER, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
    except OSError:
        pass


def _client():
    # The OpenAI SDK does not auto-read MODEL_API_KEY, so pass it explicitly.
    return OpenAI(base_url=BASE_URL, api_key=os.environ["MODEL_API_KEY"], timeout=600)


def _approval_text(question, reason):
    return (
        f"Send this text to {MODEL}?\n\n"
        f"    {question}\n\n"
        f"    {len(question.encode())} bytes leaves this device\n"
        f"    reason: {reason or '(none given)'}\n\n"
        "Nothing else is sent: no conversation history, no files."
    )


def _ask_gate(question, reason):
    """Ask Hermes' approval gate: CLI prompt, messaging gateway, or /v1/runs event."""
    from tools.approval import request_tool_approval

    # rule_key is digest-derived, so approving one text never approves another.
    return request_tool_approval(
        TOOL,
        _approval_text(question, reason),
        rule_key=f"remote_model:{_digest(question)[:16]}",
    )


def _not_sent(verdict):
    """The tool result for a refusal. A denial invites a rewrite; nothing else does."""
    if verdict.get("outcome") != "denied":
        return f"Nothing was sent. {verdict.get('message') or 'Approval was not granted.'}"
    feedback = verdict.get("deny_reason")
    said = f' The user said: "{feedback}".' if feedback else ""
    return (
        f"The user did not approve this text, and nothing was sent.{said} If the "
        "user wants changes, rewrite the question to match and call "
        f"{TOOL} again; the new text goes back to the user for approval. "
        "Otherwise continue without the remote model."
    )


def _handler(args, **_kw):
    """Approve, then send. The string shown is the string sent."""
    args = args or {}
    question = args.get("question")
    if not isinstance(question, str) or not question.strip():
        return json.dumps({"success": False, "error": f"{TOOL} needs a question."})
    # Check the key before the prompt, so nobody approves text that can't be sent.
    if not os.environ.get("MODEL_API_KEY"):
        return json.dumps({
            "success": False,
            "error": "Nothing was sent: MODEL_API_KEY is not set. Add it to the file "
            "`hermes config env-path` prints, then restart Hermes.",
        })

    try:
        verdict = _ask_gate(question, args.get("reason"))
    except Exception as exc:
        _ledger(event="gate error", model=MODEL, error=type(exc).__name__)
        return json.dumps({"success": False, "error": "Nothing was sent: the approval gate failed."})
    if not verdict.get("approved"):
        _ledger(event="not sent", outcome=verdict.get("outcome", "blocked"), model=MODEL)
        return json.dumps({"success": False, "error": _not_sent(verdict)})

    started = time.time()
    try:
        response = _client().responses.create(model=MODEL, input=question)
        answer = response.output_text
    except Exception as exc:
        _ledger(event="remote error", model=MODEL, error=type(exc).__name__)
        return json.dumps({"success": False, "error": f"remote call failed: {exc}"})

    _ledger(
        event="sent",
        bytes=len(question.encode()),
        digest=_digest(question),
        model=MODEL,
        ms=round((time.time() - started) * 1000),
    )
    return json.dumps({"success": True, "model": MODEL, "answer": answer})


def register(ctx):
    ctx.register_tool(
        name=TOOL,
        toolset=TOOLSET,
        schema=SCHEMA,
        handler=_handler,
        description="Ask Muse Spark, with explicit user approval first.",
        emoji="🛰️",
    )
