# Codever Matrix/PWA rewrite

Status: implementation branch

This branch replaces Telegram as Codever's product surface. Matrix is used as an
untrusted encrypted store-and-forward transport. It is not an execution
authority and it is not the source of truth for local agent state.

## Product shape

- Mobile installs the Codever PWA and never runs a Gateway.
- Desktop installs the same web UI together with a local Gateway service.
- A Gateway can also be installed independently on a headless machine.
- One private encrypted Matrix room maps to one Codever conversation.
- Existing Matrix clients receive standard `m.room.message` fallbacks.
- Codever-specific fields add tool cards, decisions, streaming state and
  session controls for the PWA.

## Runtime shape

```text
Codever PWA / enrolled Matrix client
  -> encrypted Matrix room event
  -> MatrixTransport
  -> MatrixIncomingRouter
  -> local device pin + replay check
  -> Codever execution authorization
  -> SemanticSessionRuntime
  -> AgentProvider / ACP
  -> ConversationEvent
  -> MatrixPort
  -> encrypted Matrix room event
```

Matrix delivery is append-only from the Gateway's perspective. Edits,
redactions, membership changes and power-level changes never directly mutate
local execution state.

## Room model

Each Codever conversation owns one private encrypted room. The Matrix room ID is
a transport locator, not a Codever identity. A local binding record maps:

```text
conversationId <-> roomId <-> gatewayId <-> provider session
```

Sensitive business data must not be written to unencrypted Matrix state:

- repository or workspace paths;
- prompts, agent output or tool arguments;
- provider-native session IDs;
- provider credentials;
- execution authorization keys.

Room names and topics use non-sensitive fallback values. The PWA derives real
display data from encrypted Codever events.

## Protocol layers

1. Standard Matrix content provides readable fallbacks for ordinary clients.
2. `io.codever.*` extension content provides structured PWA rendering.
3. A Codever authorization envelope binds an exact mutation to a locally
   enrolled device, Gateway and conversation.
4. Stable command IDs and a persistent request ledger make Matrix redelivery
   idempotent.

## Compatibility modes

Strict mode is the default. Only Codever-signed commands may invoke the local
runtime.

An explicit compatibility mode may authorize a pinned Matrix device for text
commands. It still requires a decrypted event from the exact locally pinned
device and persistent replay detection. Room membership alone never authorizes
execution.

## Migration boundary

The existing ACP providers and semantic event normalization remain reusable.
Telegram handlers, Telegram persistence keys, Telegram rendering and bot
pairing are outside the new runtime. They remain on `master` until the Matrix
vertical slice reaches feature parity.

