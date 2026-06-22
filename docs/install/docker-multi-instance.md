---
summary: "Run one central LLM-auth hub and multiple isolated OpenClaw worker gateways with Docker Compose"
read_when:
  - You want multiple OpenClaw instances on one host
  - You want workers to reuse one central OpenAI/ChatGPT authentication store
  - You are migrating a local gateway into Docker
title: "Docker Multi-Instance"
---

This deployment runs one central `llm-hub` container plus one or more worker
gateways. Workers keep separate state, workspaces, and Fluxer bot tokens, but
they do not store OpenAI/ChatGPT credentials. Instead, they call the internal
`llm-hub` LLM Gateway over Docker networking.

The bundled Compose file does not publish host ports. Containers can talk to
each other on the private `openclaw-internal` network, and Fluxer/LLM traffic is
outbound from the containers.

## Layout

The bootstrap script creates this tree by default:

```text
~/.openclaw-instances/
  llm-hub/
    instance.env
    state/openclaw.json
    state/agents/main/agent/openclaw-agent.sqlite
  pablo-0/
    instance.env
    state/openclaw.json
    workspace/
  pablo-1/
    instance.env
    state/openclaw.json
    workspace/
  pablo-2/
    instance.env
    state/openclaw.json
    workspace/
```

`llm-hub` owns copied provider auth and routes stable worker-facing model names
to upstream provider models. Workers receive only:

- `LLM_HUB_TOKEN`, used as `Authorization: Bearer ...` to
  `http://llm-hub:18789/llm/v1/chat/completions`
- their own `FLUXER_BOT_TOKEN`

## LLM Gateway Routing

The hub exposes OpenAI-compatible chat completions under `/llm/v1`, but workers
do not need to know the upstream provider model directly. For example, this
hub config exposes `gpt-5.5` and routes it to OpenAI:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "modelProxy": {
          "enabled": true,
          "defaultProvider": "openai",
          "defaultModel": "gpt-5.5",
          "routes": {
            "gpt-5.5": "openai/gpt-5.5"
          },
          "allowedModels": ["gpt-5.5"]
        }
      }
    }
  }
}
```

Workers then configure only the gateway-facing model:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "openclaw-llm/gpt-5.5" }
    }
  }
}
```

For bootstrap, set `OPENCLAW_LLM_MODEL_REF` to the upstream provider/model and
optionally set `OPENCLAW_LLM_GATEWAY_MODEL` to the stable model name exposed to
workers:

```bash
OPENCLAW_LLM_MODEL_REF="openai/gpt-5.5" \
OPENCLAW_LLM_GATEWAY_MODEL="gpt-5.5" \
scripts/docker/setup-multi-instance.sh --force
```

## Bootstrap

From the repo root:

```bash
scripts/docker/setup-multi-instance.sh
```

To build the local image too:

```bash
scripts/docker/setup-multi-instance.sh --build
```

Use env vars to set additional worker Fluxer tokens before bootstrapping:

```bash
export FLUXER_PABLO_1_BOT_TOKEN="<pablo-1 Fluxer bot token>"
export FLUXER_PABLO_2_BOT_TOKEN="<pablo-2 Fluxer bot token>"
scripts/docker/setup-multi-instance.sh --force
```

If `FLUXER_PABLO_0_BOT_TOKEN` is not set, the script tries the current
`~/.openclaw/openclaw.json` Fluxer token for the `pablo-0` worker.

## Migrate Current Gateway

Do not run the old host gateway and the Docker `pablo-0` worker with the same
Fluxer bot token at the same time.

Recommended sequence:

```bash
scripts/docker/setup-multi-instance.sh --build
sudo systemctl stop openclaw-fluxer.service
scripts/docker/setup-multi-instance.sh --refresh-auth
docker compose -f deploy/docker/openclaw-multi-instance.compose.yml up -d llm-hub pablo-0
```

After verifying `pablo-0`, disable the old unit:

```bash
sudo systemctl disable openclaw-fluxer.service
```

Start the extra workers only after each has a distinct Fluxer bot token:

```bash
docker compose -f deploy/docker/openclaw-multi-instance.compose.yml \
  --profile extra-workers up -d pablo-1 pablo-2
```

## Verify

```bash
docker compose -f deploy/docker/openclaw-multi-instance.compose.yml \
  --profile extra-workers ps
```

Logs:

```bash
docker compose -f deploy/docker/openclaw-multi-instance.compose.yml \
  logs -f llm-hub pablo-0
```

Optional LLM Gateway smoke from the `pablo-0` container:

```bash
docker compose -f deploy/docker/openclaw-multi-instance.compose.yml exec pablo-0 \
  node -e 'fetch("http://llm-hub:18789/llm/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_HUB_TOKEN}`
    },
    body: JSON.stringify({
      model: process.env.OPENCLAW_LLM_GATEWAY_MODEL || "gpt-5.5",
      messages: [{ role: "user", content: "Say ok." }],
      max_completion_tokens: 16
    })
  }).then(async (r) => {
    console.log(r.status);
    console.log((await r.text()).slice(0, 500));
  })'
```

## Refresh LLM Auth

When you re-login or rotate provider auth on the host source profile, refresh
the copy used by `llm-hub`:

```bash
sudo systemctl stop openclaw-fluxer.service
scripts/docker/setup-multi-instance.sh --refresh-auth
docker compose -f deploy/docker/openclaw-multi-instance.compose.yml restart llm-hub
```

If Docker is already the source of truth, log in inside `llm-hub` instead of
copying from the host profile.

## Add More Workers

The checked-in Compose file includes `pablo-0`, `pablo-1`, and `pablo-2`. For
more workers:

1. Copy one worker service block in
   `deploy/docker/openclaw-multi-instance.compose.yml`.
2. Change the service name and bind-mount paths, for example `pablo-3`.
3. Run bootstrap with the worker id included:

```bash
OPENCLAW_WORKER_IDS="pablo-0 pablo-1 pablo-2 pablo-3" \
FLUXER_PABLO_3_BOT_TOKEN="<pablo-3 Fluxer bot token>" \
scripts/docker/setup-multi-instance.sh --force
```
