---
summary: "Fluxer bot-token channel setup and target syntax"
read_when:
  - Connecting OpenClaw to a Fluxer server
  - Testing Fluxer bot identities
title: "Fluxer"
---

Fluxer connects OpenClaw to a Fluxer-compatible server through a Fluxer bot token.
The bundled channel plugin is text-only: it receives Gateway `MESSAGE_CREATE`
events and sends channel or direct messages through the Fluxer HTTP API.

## Quick setup

Create or copy a Fluxer bot token from your Fluxer server, then configure
OpenClaw:

```json5
{
  channels: {
    fluxer: {
      enabled: true,
      baseUrl: "http://192.168.240.117",
      token: { source: "env", provider: "default", id: "FLUXER_BOT_TOKEN" },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      requireMention: true,
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Then run:

```bash
export FLUXER_BOT_TOKEN="..."
openclaw gateway
```

If you omit `apiBaseUrl`, OpenClaw uses `${baseUrl}/api/v1`. If your Fluxer
deployment exposes the API or Gateway on custom URLs, set `apiBaseUrl` or
`gatewayUrl` explicitly. Bare Gateway URLs returned by Fluxer are connected with
`v=1&encoding=json` automatically.

## Access Model

Direct messages use `dmPolicy`; the default is `pairing`. Set `dmPolicy: "open"`
only when your Fluxer server and bot invite model already provide the access
control you want.

Community and group channels use `groupPolicy`; the default is `allowlist`.
Messages in groups require a bot mention by default. OpenClaw detects mentions
from Fluxer's `message.mentions` array and the bot user id learned from Gateway
`READY`. You can override mention gating globally with `requireMention` or per
channel with `groups.<channel_id>.requireMention`.

## Ambient group context

Fluxer supports OpenClaw ambient room events. Use this when the bot should read
normal community/channel chatter as quiet context, but only answer visibly when
someone explicitly mentions the bot or sends a command:

```json5
{
  messages: {
    groupChat: {
      unmentionedInbound: "room_event",
      historyLimit: 50,
    },
  },
  channels: {
    fluxer: {
      enabled: true,
      baseUrl: "http://192.168.240.117",
      token: { source: "env", provider: "default", id: "FLUXER_BOT_TOKEN" },
      groupPolicy: "open",
      requireMention: true,
      groups: { "*": { requireMention: true } },
    },
  },
}
```

With that policy, unmentioned allowed group messages are dispatched as
`room_event` turns. Final text from those turns stays private; mentioned
messages remain ordinary user requests and can reply normally.

For a stricter production setup, keep the defaults and allow only specific
channels and users:

```json5
{
  channels: {
    fluxer: {
      enabled: true,
      baseUrl: "https://fluxer.example.com",
      token: { source: "env", provider: "default", id: "FLUXER_BOT_TOKEN" },
      groupPolicy: "allowlist",
      groupAllowFrom: ["channel:123456789"],
      groups: {
        "123456789": {
          requireMention: true,
          allowFrom: ["user:987654321"],
        },
      },
    },
  },
}
```

## Multiple Bots

Each account opens its own Gateway connection and uses its own token.

```json5
{
  channels: {
    fluxer: {
      enabled: true,
      baseUrl: "https://fluxer.example.com",
      defaultAccount: "service",
      accounts: {
        service: {
          token: { source: "env", provider: "default", id: "FLUXER_SERVICE_BOT_TOKEN" },
          defaultTo: "channel:123456789",
        },
        personal: {
          token: { source: "env", provider: "default", id: "FLUXER_PERSONAL_BOT_TOKEN" },
          defaultTo: "dm:987654321",
        },
      },
    },
  },
}
```

## Targets

- `channel:<channel_id>` sends to a Fluxer channel.
- A bare Fluxer snowflake id is treated as `channel:<channel_id>`.
- `dm:<user_id>` creates or reuses a direct channel with that user before
  sending.

Examples:

```bash
openclaw message send --channel fluxer --target channel:123456789 --message "hello"
openclaw message send --channel fluxer --target 123456789 --message "hello"
openclaw message send --channel fluxer --target dm:987654321 --message "hello"
```

Agents can also send visible Fluxer replies through the shared message tool:

```text
message(action="send", channel="fluxer", target="channel:123456789", message="hello")
message(action="send", channel="fluxer", target="dm:987654321", message="hello")
```

When a Fluxer message is the current source conversation, `target` may be
omitted and OpenClaw sends back to that Fluxer conversation.

Replies from inbound messages include Fluxer's `message_reference` so the server
can associate the OpenClaw response with the triggering message. Long text is
split into Fluxer-sized message chunks before sending.

## Troubleshooting

- `Fluxer is not configured`: set `channels.fluxer.baseUrl` and either
  `channels.fluxer.token` or `FLUXER_BOT_TOKEN`.
- No inbound replies in a group: confirm the bot was invited, the channel passes
  `groupPolicy`, and the message mentions the bot when `requireMention` is true.
- DM messages are ignored: complete pairing or set `dmPolicy` and `allowFrom`
  for the user you expect.
- Sends fail with an authorization error: verify the token belongs to a Fluxer
  bot and the server accepts `Authorization: Bot <token>`.
- Gateway closes with `Invalid API version` or `Invalid identify payload`: use a
  current OpenClaw build. The Fluxer channel identifies with `Bot <token>`,
  gateway version `1`, JSON encoding, and guild plus DM message intents.
