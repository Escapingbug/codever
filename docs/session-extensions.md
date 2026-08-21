# Session Extensions

## Product boundary

Codever provides a generic, trusted session-extension platform. It does not
implement privacy policy, entity detection, mappings, reverse mappings,
privacy models, vaults, audit records, preview wording, or the meaning of an
extension action.

An extension owns that behavior and talks to the Gateway through a small local
HTTP protocol. Codever owns only:

- administrator-controlled discovery and authentication;
- project defaults and session bindings;
- extension lifecycle and hook ordering;
- pausing and resuming a turn while an interaction is shown;
- bounded declarative UI rendering and action routing;
- timeout, validation, persistence, and fail-closed behavior.

The resulting runtime flow is:

```text
channel input
  -> SemanticSessionRuntime
  -> each bound extension: prepare turn
       ready ------------------------------+
       interaction required -> show View   |
                              -> return action ID to the same extension
                              -> ready/cancel
  -> AgentProvider / ACP                    |
  -> canonical ConversationEvent journal   |
  -> each bound extension in reverse order: present event
  -> ChannelProjector -> channel
```

With no bindings, the extension host is an exact pass-through. Provider events
are journaled before presentation hooks, so display-time transformations do not
rewrite the canonical provider history.

## Extension granularity

An installed extension is available to a project, while the effective binding
belongs to a session:

```text
installed extension manifest
             |
             v
project.defaultExtensions       <- template for future sessions
             |
       snapshot at create
             v
session.extensions              <- independent effective binding
```

- A project default is only a creation template. Updating it does not mutate
  existing sessions.
- Creating a session without an explicit extension selection copies the current
  project defaults.
- Creating a session with an explicit list, including `[]`, uses that exact list.
- A user may later change one session's binding. Codever invokes the old
  extension lifecycle with `replace`, recreates the runtime, increments the
  session extension revision, and starts a fresh provider conversation. This
  prevents protected and unprotected content from sharing one provider context.
- Provider or model changes never silently add or remove bindings.

Only the binding is persisted by Codever:

```ts
interface SessionExtensionBinding {
  id: string
  config?: Record<string, JsonValue>
}
```

Extension secrets and mutable extension state remain in extension-owned
storage. Config intended to be secret must be represented by an opaque
extension-owned identifier rather than placed in a binding.

## Discovery and trust

Extensions that transform prompts or events can see content at their declared
hook boundary and are therefore highly privileged. Installation is a local
Gateway administrator action. A PWA or Matrix command can select an advertised
extension and submit manifest-declared settings, but cannot register code, an
endpoint, or a bearer token.

At startup the Gateway connects to each configured loopback endpoint and calls:

```http
GET /v1/manifest
Authorization: Bearer <shared secret>
```

The extension owns and returns its descriptor:

```json
{
  "protocolVersion": 1,
  "descriptor": {
    "id": "example-extension",
    "name": "Example extension",
    "description": "Transforms a session for an extension-owned purpose.",
    "version": "1",
    "settings": []
  }
}
```

This avoids duplicating extension metadata in Codever configuration. An
optional `expectedExtensionId` pins the discovered identity. Registrations are
loopback HTTP only, bearer tokens must contain at least 32 bytes, and a missing
or invalid manifest fails Gateway startup rather than installing a partially
known extension.

## Turn and presentation protocol

The Gateway calls the following authenticated extension-owned endpoints:

| Endpoint | Responsibility |
| --- | --- |
| `POST /v1/turns/prepare` | Pass through, transform, block, or request an interaction before provider egress. |
| `POST /v1/interactions/respond` | Receive the user's opaque action ID and return a ready or cancelled result. |
| `POST /v1/events/present` | Transform or suppress normalized provider events before channel rendering. |
| `POST /v1/sessions/lifecycle` | Observe `archive`, `delete`, `replace`, or `shutdown`. |

A ready preparation returns the provider input and may return an opaque
`stateRef` for later presentation calls. An interactive preparation returns a
short-lived opaque `preparationToken`, a declarative `view`, and a
`cancelActionId`. Codever renders the view, routes exactly one selected action
ID back with the token, and continues only if the extension returns `ready`.
Codever never interprets action names such as `send`, `retry`, or `reveal`.

Bound extensions are composed in binding order for input and reverse order for
presentation. If any bound extension times out, is unavailable, or returns an
invalid response, the affected operation fails closed. Unbound sessions remain
unaffected.

## Declarative UI contract

Extensions cannot inject JavaScript or channel-specific components. View V1 is
a bounded data model rendered natively by each Codever client:

```ts
interface SessionExtensionView {
  version: 1
  title: string
  elements: Array<
    | { type: 'status'; tone: 'info' | 'success' | 'warning' | 'error'; text: string }
    | { type: 'text'; text: string }
    | { type: 'readonly_textarea'; label: string; value: string }
    | { type: 'list'; label?: string; items: string[] }
  >
  actions: Array<{
    id: string
    label: string
    style?: 'primary' | 'secondary' | 'danger'
  }>
}
```

V1 permits at most 16 elements, 8 actions, and 16 KiB for the whole view. An
action ID is a bounded opaque protocol value, not a Codever enum. One action
must be designated as cancellation. Read-only text areas are capped at 8 KiB
and support exact extension-owned previews such as a sanitized prompt.

The PWA renders the full card. Telegram renders the same semantic content as
escaped text plus inline buttons. Android receives the same CVP/3 interaction
event through its native projection. Resolution is a persisted CVP/3 event, so
other devices replace the pending control with the selected outcome instead of
leaving a stale actionable UI.

## Project and CVP/3 protocol state

Project snapshots advertise:

- installed extension descriptors;
- `defaultExtensions`;
- `extensionDefaultsRevision`.

Session snapshots advertise safe extension summaries and
`extensionRevision`; `session.ready` also contains the exact normalized
bindings. `project.update` changes the project template. `session.create`
captures it when extensions are omitted. `session.update` changes only that
session.

Old persisted CVP/3 records migrate to empty project defaults and empty session
bindings. Existing unbound behavior is unchanged.

## Reference privacy extension

`extensions/has-privacy` is an independently runnable reference extension and
is intentionally outside the pnpm workspace/product build. It demonstrates
that the generic contract is sufficient for privacy protection; Codever core
does not import its implementation.

The extension, not Codever, owns:

- local HaS model communication and privacy policy;
- exact sanitized-input preview and its button labels/actions;
- preview freshness and commit decisions;
- encrypted immutable mapping versions and reverse mapping;
- output restoration, privacy audit, and retention.

Its first slice protects text prompts and text-bearing provider events. A bound
privacy session rejects file, image, and audio input until an extension-owned
artifact adapter handles those kinds. This is deliberate fail-closed behavior.

## Local installation

Start the privacy model and extension separately, with extension-owned secrets:

```text
HAS_EXTENSION_TOKEN=<random shared secret, at least 32 bytes>
HAS_PRIVACY_VAULT_KEY=<base64 encoded 32-byte key>
HAS_MODEL_REVISION=<immutable model artifact digest>
HAS_ENDPOINT=http://127.0.0.1:18080/v1/chat/completions
HAS_PRIVACY_STATE_DIR=/private/codever-has-state
```

Then register only the generic connection in the Gateway:

```text
CODEVER_SESSION_EXTENSIONS_JSON=[
  {
    "endpoint": "http://127.0.0.1:8791",
    "bearerToken": "<same random shared secret>",
    "expectedExtensionId": "has-privacy"
  }
]
```

The endpoint and token remain local Gateway configuration. Only the discovered
safe descriptor is advertised to clients.

## Verification boundary

Core conformance tests use a non-privacy `prefix-transform` fake extension to
prove the platform does not depend on privacy-specific action names or data.
`e2e/session-extension-has.test.ts` separately starts the real reference
extension process and verifies sanitize/preview/action/provider/restore,
cancellation, and offline fail-closed behavior over authenticated loopback HTTP.

The product privacy journey remains specified in
`docs/business-e2e-acceptance.md`; it validates the reference extension as a
consumer of the platform, not as logic embedded in Codever core.
