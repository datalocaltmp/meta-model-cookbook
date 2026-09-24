# Build a Local Agent That Asks Before Calling Muse Spark

|  |  |
|---|---|
| **Section** | [Use cases](https://dev.meta.ai/docs/cookbook#use-cases) |
| **Time to complete** | ~40 min |
| **Model** | `muse-glimmer-30b` locally, `muse-spark-1.3` on Meta Model API |
| **Harness** | Hermes |
| **Prerequisites** | An existing Hermes install, Muse Glimmer served on any supported runtime, a Meta Model API key |

Build an agent that runs on your own hardware with Muse Glimmer and calls Muse Spark on Meta Model API only after you approve the text it sends.

## Summary

This recipe adds two things to a Hermes install you already have: Muse Glimmer as the local model, and a `consult_remote_model` tool that calls Muse Spark on Meta Model API. Every call to that tool waits for your approval in Hermes.

## What's in this folder

| Path | What it is |
|---|---|
| [`remote-model/`](remote-model/) | The Hermes plugin: manifest plus `__init__.py` with the tool, which asks Hermes' approval gate before it sends. |
| [`hermes-config.yaml`](hermes-config.yaml) | The keys to merge into `$HERMES_HOME/config.yaml` to make Muse Glimmer the default model. |
| [`tests/`](tests/) | Tests for the approval flow and the handler. No network and no Hermes install needed. |

## When to use

Use this pattern when:

- Your data has handling requirements that make a default-cloud agent a non-starter, and a local-only agent isn't capable enough on its own.
- You want an auditable record of what left the machine, separate from the model's own account of what it did.
- The escalation is occasional. A local model handles most steps; a stronger model handles a few.

Use a single cloud model when every step needs frontier capability. Each approval adds a human round trip.

## How it works

1. **Hermes runs the agent loop against Muse Glimmer** on your own hardware. File reads, shell commands, and reasoning stay local.
2. **The model decides it needs more capability** and calls `consult_remote_model` with a self-contained question.
3. **The tool asks Hermes' approval gate** before any network call. The prompt shows the exact outbound text and its size.
4. **You approve or deny.** To change the question, deny it and say what to change. Muse Glimmer rewrites it, and the new text comes back for approval.
5. **On approval, the tool sends that same string to Muse Spark** through Meta Model API. It logs the digest, byte count, destination, and duration to `$HERMES_HOME/egress.jsonl`. The log doesn't store the question or the answer.

A denied, timed-out, or failed approval sends nothing. The tool's arguments carry no endpoint or key, so the model can't choose where the question goes.

## Before you start

You need a working [Hermes](https://hermes-agent.nousresearch.com/) install. This recipe calls its config directory `$HERMES_HOME`. Ask Hermes where its files are instead of assuming `~/.hermes`:

```bash
hermes --version
hermes config path       # config.yaml
hermes config env-path   # .env, where secrets live
export HERMES_HOME="$(dirname "$(hermes config path)")"
```

If Hermes runs in a container, run every `hermes` command in this recipe inside it, for example `docker exec <container> hermes config path`. `$HERMES_HOME` is then the host directory mounted at that path. Edit files there as the directory's owner, so Hermes can still read and update them.

Get a Meta Model API key from [dev.meta.ai](https://dev.meta.ai/). You don't need to export it. The install step stores it in Hermes' `.env`, so it never lands in `config.yaml` or source.

Clone this repo for the config fragment and the tests:

```bash
git clone https://github.com/meta-models/meta-model-cookbook.git
cd meta-model-cookbook/03_use_cases/15_glimmer_api_agent
```

## Serve Muse Glimmer locally

Muse Glimmer runs on the hardware you already have. The weights are on Hugging Face under [`meta-models`](https://huggingface.co/meta-models), with the bf16 checkpoint in [`Muse-Glimmer-30B`](https://huggingface.co/meta-models/Muse-Glimmer-30B) and quantized builds in [`Muse-Glimmer-30B-GGUF`](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF). [Get the model](https://dev.meta.ai/docs/muse-glimmer/get-the-model) explains which build each runtime needs.

Serve it with whichever runtime suits your machine:

- [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/llama-cpp): CPU, NVIDIA, AMD, and Apple Metal, or a mix.
- [vLLM](https://dev.meta.ai/docs/muse-glimmer/vllm): production throughput on NVIDIA GPUs.
- [SGLang](https://dev.meta.ai/docs/muse-glimmer/sglang): concurrent users on NVIDIA GPUs or Apple silicon.
- [OpenVINO](https://github.com/openvinotoolkit/model_server): Intel CPUs and GPUs, including Arc.
- [Ollama](https://ollama.com/): one-command local serving on macOS, Linux, and Windows.
- [LM Studio](https://lmstudio.ai/): a desktop app with a built-in local server.

[Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy) compares the runtimes and walks through each deployment.

Hermes needs two things from the runtime: an OpenAI-compatible base URL and the model ID the server reports. Each runtime's default base URL:

| Runtime | Default base URL |
|---|---|
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |
| SGLang | `http://localhost:30000/v1` |
| OpenVINO Model Server | `http://localhost:<rest_port>/v3` |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |

Confirm the server is up and read the model ID from it:

```bash
curl -s http://localhost:8080/v1/models
```

Serve a build with the vision projector if you want image input, and enable tool calling in the runtime so the agent can call `consult_remote_model`.

## Point Hermes at Muse Glimmer

Merge the keys from [`hermes-config.yaml`](hermes-config.yaml) into `$HERMES_HOME/config.yaml`, replacing the base URL and model ID with your runtime's. They add a custom provider for your local server and make it the default model:

```yaml
model:
  default: muse-glimmer-30b
  provider: custom:glimmer-local
  base_url: http://localhost:8080/v1
  api_key: local-only
  api_mode: chat_completions
  context_length: 65536

custom_providers:
  - name: glimmer-local
    base_url: http://localhost:8080/v1
    api_key: local-only
    model: muse-glimmer-30b
    api_mode: chat_completions
    models:
      muse-glimmer-30b:
        context_length: 65536
        vision: true
        tools: true

fallback_providers: []
```

Local servers need no real key, so `local-only` is a placeholder the client requires. Set `vision: true` so image input reaches the model, and `tools: true` so the agent can call `consult_remote_model`.

Keep `fallback_providers` empty. A non-empty list lets a local failure become a cloud call with no approval prompt.

Confirm Hermes is talking to the local model:

```bash
hermes chat --oneshot -q "Reply with exactly: OK"
```

## Add the remote-model tool

A Hermes [plugin](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) is a directory under `$HERMES_HOME/plugins/` with a `plugin.yaml` manifest and an `__init__.py` whose `register(ctx)` wires up what it provides. Install this one from the repo:

```bash
hermes plugins install \
  https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/15_glimmer_api_agent/remote-model \
  --enable
```

The installer fetches only the `remote-model` folder and names it from the manifest. The manifest declares `MODEL_API_KEY` under `requires_env`, so the installer asks for the key with hidden input if it isn't set. If the key goes missing later, the tool refuses each call before it shows an approval prompt. Plugins are opt-in; `--enable` adds this one to `plugins.enabled` in `config.yaml`.

To install from your clone instead, copy the folder and enable it. Decline the tool-override grant; the plugin adds a tool and doesn't replace any:

```bash
cp -r remote-model "$HERMES_HOME/plugins/"
hermes plugins enable remote-model --no-allow-tool-override
```

A manual copy skips the installer, so nothing asks for the key. Add `MODEL_API_KEY=...` to the file `hermes config env-path` prints, with an editor rather than a command line, so the key stays out of your shell history.

In a container, copy the folder on the host into the mounted directory as its owner, or with `docker exec --user <uid>:<gid>` as the user that runs Hermes. Then check the owner of the copied files.

The plugin calls Muse Spark over the Responses API with the OpenAI SDK, which Hermes already ships. The base URL, model, and key come from the environment:

```python
BASE_URL = os.environ.get("REMOTE_MODEL_BASE_URL", "https://api.meta.ai/v1")
MODEL = os.environ.get("REMOTE_MODEL_NAME", "muse-spark-1.3")


def _client():
    # The OpenAI SDK does not auto-read MODEL_API_KEY, so pass it explicitly.
    return OpenAI(base_url=BASE_URL, api_key=os.environ["MODEL_API_KEY"], timeout=600)
```

The handler asks the gate, then sends the same `question` string the prompt showed:

```python
def _ask_gate(question, reason):
    """Ask Hermes' approval gate: CLI prompt, messaging gateway, or /v1/runs event."""
    from tools.approval import request_tool_approval

    # rule_key is digest-derived, so approving one text never approves another.
    return request_tool_approval(
        TOOL,
        _approval_text(question, reason),
        rule_key=f"remote_model:{_digest(question)[:16]}",
    )


def _handler(args, **_kw):
    """Approve, then send. The string shown is the string sent."""
    ...
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
        ...
```

The full plugin is in [`remote-model/__init__.py`](remote-model/__init__.py).

### Check it loaded

A new CLI session picks up the plugin. A running gateway doesn't: after you install the plugin, enable it, or change its key, restart the gateway with `hermes gateway restart` or your service manager. Then confirm it's enabled, valid, and its toolset is on:

```bash
hermes plugins list
hermes plugins doctor --ci remote-model
hermes tools list | grep remote
```

Inside a session, `/plugins` lists what loaded, and `remote-model` should be on it with one tool. If it's missing, `HERMES_PLUGINS_DEBUG=1 hermes plugins list` prints why each plugin was skipped.

## Verify the approval gate

Start a session and give the agent a question it can't answer locally:

```bash
hermes chat
```

```
> Use the remote model to find out how the US wash sale rule adjusts the
  cost basis of replacement shares.
```

The gate interrupts before any network call:

```
Send this text to muse-spark-1.3?

    How does the US wash sale rule adjust the cost basis of replacement shares?

    75 bytes leaves this device
    reason: needs current tax-rule specifics beyond local knowledge

Nothing else is sent: no conversation history, no files.

  1) Allow once   2) Allow for this session   3) Always allow   4) Deny
```

Run these checks:

- **Approve**: the tool runs and the answer comes back. A `sent` row appears in `$HERMES_HOME/egress.jsonl`.
- **Revise**: deny, then tell the agent what to change, for example "Make it about the general rule, not my brokerage." Muse Glimmer rewrites the question and the gate shows the new text. Repeat until the text is right, then approve.
- **Deny**: deny and ask for nothing else. The agent continues locally, and a `not sent` row records the refusal.
- **Timeout**: leave the prompt untouched. The call is denied after `approvals.timeout` seconds (300 by default), and the agent isn't invited to retry.
- **Scoping**: choose *Allow for this session*, then ask a different question. The gate prompts again, because the digest differs.

On messaging platforms, `/deny <what to change>` denies and passes your words to the model in one step.

Check the ledger:

```bash
tail -2 "$HERMES_HOME/egress.jsonl"
```

```json
{"event": "sent", "bytes": 75, "digest": "25db24bf…", "model": "muse-spark-1.3", "ms": 1840, "ts": "2026-09-23T01:12:44"}
```

## Approve from WhatsApp

Hermes shows the approval prompt on the surface the session runs on: an interactive prompt in the CLI, or a message on a platform connected through the gateway. The plugin needs no changes.

To answer approvals from your phone, set up WhatsApp with the Hermes [WhatsApp Cloud guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud). Reply `/deny <what to change>` to send the question back for a rewrite.

Treat the messaging surface as part of the trust boundary. Anyone who can send to that thread can approve an escalation.

## Understand the approval gate

The tool asks for approval through `request_tool_approval`, the gate Hermes uses for dangerous shell commands. The gate provides three things:

- **Every surface**: the same prompt appears in the CLI, on messaging platforms through the gateway, and as an event on the runs API.
- **Refusal by default**: a denial, a timeout, or a session with nobody to answer refuses the call. So does a gate that errors or can't be imported.
- **Scoped approvals**: `rule_key` sets what an approval covers. The plugin derives it from a digest of the outbound text, so *Allow for this session* covers that text only, and a different question prompts again. A static `rule_key` would allowlist the tool on the first approval.

Hermes also offers a `pre_tool_call` plugin hook that can send any tool to this gate. Hermes applies other plugins' `modify` directives after that hook runs, so the approved text could differ from the sent text. Calling the gate from the handler keeps them the same.

`request_tool_approval` isn't part of the documented plugin API. If a Hermes release moves it, the tool refuses every call until the plugin is updated, so pin a Hermes version you've tested.

Don't run `hermes --yolo` or `/yolo` with this plugin. Both skip every approval prompt, this one included. The gate covers this tool only; the agent's other tools, such as the shell, have their own guards.

### Gate other tools

To require approval for other tools, write a small plugin with a `pre_tool_call` hook. It returns `approve` for the tools you name and `None` for everything else:

```python
GATED = {"web_extract", "send_message"}  # the tool names to gate


def pre_tool_call(tool_name=None, args=None, **_kw):
    if tool_name not in GATED:
        return None
    return {"action": "approve", "message": f"Run {tool_name} with {args}?", "rule_key": tool_name}


def register(ctx):
    ctx.register_hook("pre_tool_call", pre_tool_call)
```

Package it like `remote-model`, with `provides_hooks: [pre_tool_call]` in its `plugin.yaml`, and enable it. A `rule_key` of the tool name lets *Allow for this session* cover the tool for the session. Derive it from the arguments to ask every time. Hermes' [hooks guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks) covers the contract.

Hermes gates dangerous shell commands on its own, and `approvals.deny` in `config.yaml` blocks matching commands. To remove a capability, disable its toolset with `hermes tools disable <toolset>`.

## Appendix: drive it from Ray-Ban Meta glasses

The glasses client is a single-purpose app built on a Device Access Toolkit sample. The rest of the recipe works without it.

The [Meta Wearables Device Access Toolkit](https://github.com/facebook/meta-wearables-dat-android) gives an Android app camera access to Ray-Ban Meta glasses. Point that app at Hermes and a photo from the glasses becomes the agent's input.

### Set up the glasses

Do these in order, and don't skip step 3:

1. **Check versions** against the [dependency matrix](https://wearables.developer.meta.com/docs/develop/dat/version-dependencies/). Device Access Toolkit 0.9.0 needs the Meta AI app at v282 or later and Ray-Ban Meta firmware at v126 or later. Glasses firmware is under **Devices → your device → gear → General → About → Release version**.
2. **Enable Developer Mode** in the Meta AI app: **profile → App settings → App info**, then tap **App version** five times and toggle it on. Developer Mode waives app attestation, so an unpublished build registers without going through publishing review. This is in the Meta AI app's own settings, not the glasses' device settings.
3. **Install the Device Access Toolkit onto the glasses.** Put the glasses on, then press the install button that appears once Developer Mode is on. It takes 5–10 seconds; keep the Meta AI app open.

The docs list step 3 under Meta Ray-Ban Display glasses, but every supported device needs it. Without it, registration succeeds and sessions still fail. The glasses chime on and then off, and the app reports `No eligible device available` or `Session ended by device`.

### Choose how the phone reaches Hermes

Hermes' API server speaks plain HTTP and checks a single shared bearer key, `API_SERVER_KEY`. It has no TLS, per-client credentials, or login rate limiting, and every request can run agent work, shell commands included, as the host user. Don't expose port 8642 to the internet. Put one of these in front of it:

| Option | What protects the traffic | What the app sends |
|---|---|---|
| **Private network** (recommended): [Tailscale](https://tailscale.com/) or [WireGuard](https://www.wireguard.com/). Bind `API_SERVER_HOST` to the machine's private network IP and add each phone to the network. | WireGuard encryption, and only enrolled devices can reach the port | The Hermes bearer key |
| **Public endpoint**: keep Hermes on `127.0.0.1` behind a TLS proxy or tunnel that checks identity, such as mTLS client certificates or [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) service tokens. | TLS, plus the proxy's identity check before a request reaches Hermes | The proxy's credential and the Hermes bearer key |

Before you share the endpoint, work through Hermes' [security guide](https://hermes-agent.nousresearch.com/docs/user-guide/security).

### Point the app at Hermes

Enable the API server with a strong key. Hermes refuses to start it without one, even on loopback:

```bash
export API_SERVER_ENABLED=true
export API_SERVER_HOST=127.0.0.1   # or the private network IP
export API_SERVER_KEY="$(openssl rand -hex 32)"
```

Configure the app with two values: `<hermes-url>` and the bearer key. `<hermes-url>` is the address from the option you chose: `http://<private-ip>:8642` on a private network, or your proxy's `https://` URL. Behind a proxy, the app also sends the proxy's credential. Keep the key and the credential in the app's secure storage, not in source. The requests below use the same URL.

Use the runs API, not `/v1/chat/completions`. Chat completions runs the agent with no approval listener attached, so any call to `consult_remote_model` comes back refused and the gate never reaches the phone. A run streams its events, including the approval request, and takes the answer back.

Start a run with the capture:

```bash
curl <hermes-url>/v1/runs \
  -H "Authorization: Bearer $API_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model from GET /v1/models>",
    "input": [{"role": "user", "content": [
      {"type": "text", "text": "What am I looking at? Answer concisely."},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<capture>"}}
    ]}]
  }'
```

```json
{"run_id": "run_…", "status": "started", "replayed": false}
```

Read the event stream:

```bash
curl -N <hermes-url>/v1/runs/<run_id>/events \
  -H "Authorization: Bearer $API_SERVER_KEY"
```

Each frame is `data: {json}` with an `event` field:

| Event | What the app does |
|---|---|
| `message.delta` | Append the text to the answer. |
| `tool.started` | Show progress, for example "Using consult_remote_model". |
| `approval.request` | Show `description` verbatim with Send and Deny buttons, and keep `request_id`. |
| `run.completed` | Show or speak `output`. |
| `run.failed`, `run.cancelled` | Show the error. |

Answer an approval with the `request_id` from the event:

```bash
curl <hermes-url>/v1/runs/<run_id>/approval \
  -H "Authorization: Bearer $API_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"choice": "once", "request_id": "<request_id>"}'
```

`choice` is one of `once`, `session`, `always`, or `deny`. This endpoint carries no feedback text, so to revise a question, deny it and start a new run with what to change. If the app never answers, the gate times out and denies, the same as on every other surface. The stream sends a keepalive comment every 30 seconds, so a read timeout of about a minute tells a dead connection apart from a slow model.

### Know the limits before you design around them

- **Sessions start in the app.** The glasses can't launch or wake it. "Hey Meta" is a system-owned transaction and isn't available to third-party apps.
- **Temple gestures are taken.** A tap pauses and resumes an active stream; tap-and-hold stops the session. They can't be remapped.
- **The microphone is the input channel.** It arrives over Hands-Free Profile at 8 kHz mono, which suits short commands better than long dictation.
- **Background operation needs a foreground service.** Declare `android:foregroundServiceType="connectedDevice"` so a session survives the app leaving the foreground.

On Android, speech in and out are platform classes and need no dependencies: `SpeechRecognizer` with `createOnDeviceSpeechRecognizer` on API 33 and later keeps transcription on the phone, and `TextToSpeech` speaks the answer back.

## Appendix: run the tests

The tests exercise the approval flow and the handler with stand-ins for Hermes' gate and the API client, so they need no network, no key, and no Hermes install:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pytest tests
```

They check that the approved text is the sent text, that nothing is sent before the gate answers, that approvals are scoped to one text, that a denial invites a rewrite while a timeout doesn't, that a missing key never reaches the prompt, and that the ledger never records content.

## Next steps

Wire the same tool into a [tool-calling loop](../../01_api_fundamentals/03_tool_calling.ipynb) of your own, and swap the destination by changing one environment variable. The [Responses API docs](https://dev.meta.ai/docs/features/responses) cover the request options the plugin leaves at their defaults.
