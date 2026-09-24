# Local Agent With Approved Escalation to Muse Spark

|  |  |
|---|---|
| **Section** | [Use cases](https://dev.meta.ai/docs/cookbook#use-cases) |
| **Time to complete** | ~40 min |
| **Model** | `muse-glimmer` locally, `muse-spark-1.3` on Meta Model API |
| **Harness** | Hermes |
| **Prerequisites** | An existing Hermes install, Ollama, ~20 GB free RAM, a Meta Model API key |

> [!NOTE]
> This recipe is in progress. The outline below describes what it will cover; code, configuration, and screenshots land in follow-up commits on this branch.

Run an agent entirely on your own hardware, and when a task outgrows the local model, reach Muse Spark on Meta Model API through a tool that stops for your explicit approval before anything leaves the machine.

## Summary

This recipe adds two things to a Hermes install you already have: Muse Glimmer as the local model, and a `consult_remote_model` tool that calls Muse Spark on Meta Model API. Every call to that tool stops at Hermes' built-in human-approval gate, and the prompt you approve is the exact text that goes out.

## What this recipe will cover

- **Serve Muse Glimmer locally** with Ollama and keep it resident.
- **Point Hermes at Muse Glimmer** as its default model, with no silent cloud fallback.
- **Add the remote-model tool**: a Hermes plugin whose `pre_tool_call` hook routes every call to the approval gate.
- **Verify the gate**: approve, deny, timeout, and per-question scoping, plus a metadata-only egress ledger.
- **Approve from your phone** through the Hermes [WhatsApp Cloud integration](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud).
- **Appendix: Ray-Ban Meta glasses**: drive the same agent from the [Meta Wearables Device Access Toolkit](https://github.com/facebook/meta-wearables-dat-android), with approvals surfaced on the phone.
