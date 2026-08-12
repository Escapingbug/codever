# Session Extensions

## Purpose

Codever remains an ACP control client and gateway. Optional behavior that wraps
an agent session, such as HaS de-identification, is supplied by a session
extension rather than being built into the product pipeline.

The core runtime does not know about privacy mappings, HaS prompts, vaults, or
document policies. It only owns two neutral extension boundaries:

```text
SessionInput
  -> SessionExtensionHost.prepareTurn
  -> AgentProvider
  -> ProviderSemanticAdapter
  -> canonical ConversationEvent (journaled)
  -> SessionExtensionHost.presentEvent
  -> ChannelProjector
```

With no extension bindings, both extension-host calls are exact pass-throughs.
Existing sessions are migrated as sessions with an empty binding list.

## Trust model

A session extension that can transform prompts or provider events is highly
privileged. It can see the content that crosses its declared boundary. Extension
registration is therefore a local Gateway administrator action, not a remote
PWA action.

The PWA may bind an installed extension to a newly created session and supply
configuration accepted by its declarative schema. It cannot register an
endpoint, inject executable UI code, or change an extension binding after the
provider session has been created.

Extension bindings are immutable session metadata:

```ts
interface SessionExtensionBinding {
  id: string
  config?: Record<string, JsonValue>
}
```

Only the binding is persisted by Codever. Secrets and extension-owned state are
referenced by opaque identifiers and remain in extension-owned storage.

## Runtime contract

`prepareTurn` can pass an input through, replace it, block it, or require an
approval. Approval content is declarative and rendered through the existing
channel decision surface. An approval token is opaque to Codever and is
committed by the extension only after the user approves.

Provider events are normalized before `presentEvent`. The unmodified canonical
event is recorded in the conversation journal. The extension returns zero or
more display events, allowing a streaming extension to retain an incomplete
token until a later chunk without putting restored content in the journal.
Journal-only `provider_raw` envelopes are never sent across the HTTP extension
boundary because they have no channel presentation.

Extensions receive lifecycle callbacks for archive, delete, replacement, and
shutdown. Restoring an archived session creates a fresh extension instance from
the immutable binding. A bound extension is fail-closed: an unavailable extension blocks the
affected session turn and is never bypassed. Sessions without that binding are
unaffected.

## PWA surface

The Gateway advertises installed extension descriptors as capabilities. The PWA
uses only declarative fields (`text`, `boolean`, and later bounded selections)
to render the optional section of the new-session dialog. If the Gateway has no
installed extensions, the section is absent and the current UI is unchanged.

Session summaries expose safe extension badges. They do not expose configuration
secrets, mapping versions, or extension process details.

From an existing user's point of view:

- if the administrator has installed no extensions, no new control is rendered;
- if extensions are installed but left off, the only change is an optional,
  off-by-default section in the new-session dialog;
- an unbound session makes no extension HTTP calls and uses the same provider,
  journal, projection, delivery, and persistence behavior as before;
- a bound session shows an extension badge, and its binding cannot be disabled
  by switching the provider or changing session settings.

## HaS extension

The HaS implementation is a separate local extension service. It owns:

- local HaS model communication;
- preview, commit, and stale-preview rejection;
- encrypted, immutable mapping versions;
- deterministic or model-assisted restoration;
- privacy audit and retention policy.

Future Metapp artifact adapters and their file API should also remain owned by
this service boundary, but they are not part of the first implementation.

The service accepts connections only on loopback and requires a shared bearer
token. The Codever Gateway communicates with it through the generic extension
protocol. Codever does not import the HaS model implementation.

Metapp uses the ordinary Codever PWA as its agent controller. Metapp keeps its
separate file and business application. A later Metapp-owned artifact adapter
can share the same opaque privacy context identifier without moving file
management into Codever.

The implemented first slice is `extensions/has-privacy`. It is intentionally
outside the pnpm workspace/product build and its tests are run independently.
It uses readable,
stable pseudonyms, a versioned AES-256-GCM mapping vault, exact outbound review,
mapping compare-and-swap, local response restoration, and metadata-only JSONL
audit records whose content digests are keyed. The real HaS adapter talks only to a loopback OpenAI-compatible
llama.cpp endpoint. A deterministic adapter exists only for tests.

## Local installation

Start HaS/llama.cpp separately, then start the extension service with secrets
provided by the local administrator:

```text
HAS_EXTENSION_TOKEN=<random shared secret, at least 32 bytes>
HAS_PRIVACY_VAULT_KEY=<base64 encoded 32-byte key>
HAS_MODEL_REVISION=<immutable model artifact digest>
HAS_ENDPOINT=http://127.0.0.1:18080/v1/chat/completions
HAS_PRIVACY_STATE_DIR=/private/codever-has-state
```

The Gateway loads generic HTTP extension registrations from
`CODEVER_SESSION_EXTENSIONS_JSON`. For the included HaS service the value is:

```json
[
  {
    "descriptor": {
      "id": "has-privacy",
      "name": "HaS privacy",
      "description": "Sanitize prompts locally before Agent egress and restore Agent output locally.",
      "version": "1",
      "settings": [
        {
          "id": "contextId",
          "type": "text",
          "label": "Privacy context",
          "description": "Stable Metapp/app instance ID used to scope the encrypted mapping.",
          "placeholder": "payroll-system-id",
          "required": true
        },
        {
          "id": "reviewRequired",
          "type": "boolean",
          "label": "Review every sanitized prompt before sending",
          "defaultValue": true
        }
      ]
    },
    "endpoint": "http://127.0.0.1:8791",
    "bearerToken": "<same random shared secret>"
  }
]
```

This registration is read only by the local Gateway process. It is not sent in
Gateway state; PWA state contains the descriptor but never the endpoint or
bearer token.

## Lifecycle and compatibility

- Direct sessions store `extensions: []` and retain current behavior.
- Creating a bound session validates the extension ID and configuration.
- Archiving releases live extension resources but preserves the binding.
- Restoring recreates the extension instance from the persisted binding.
- Deleting invokes the extension lifecycle hook; extension retention policy
  decides whether shared context data is removed.
- If an installed extension is later unavailable, its sessions are blocked and
  clearly marked unavailable. Direct sessions continue to operate.
- Provider switching never removes or bypasses extension bindings.

## Initial limitations

The first HaS vertical slice supports text prompt sanitization and text-bearing
conversation events. A protected session rejects file, image, and audio input
until an installed artifact adapter explicitly handles that kind. Metapp's
file privacy and document-management app remains separate; no file API has been
moved into Codever or this first session-extension slice. This is a deliberate
fail-closed boundary, not a silent fallback.

## Pre-merge verification

`e2e/session-extension-has.test.ts` starts the HaS extension as a real child
process, connects it over the authenticated loopback HTTP protocol to the
session runtime, uses a local simulated HaS endpoint and ACP Agent, and verifies
the complete sanitize/review/Agent/restore path. It also asserts that denial or
an offline bound extension results in zero Agent invocations. Under Codever's
test classification this is a protocol integration test, not business E2E.

`apps/pwa/e2e/session-extension-dialog.html` is a test-only browser harness for
the real new-session component. It is used at phone dimensions to verify that
HaS is off by default, required configuration is enforced, and the submitted
`session.create` binding contains only declarative configuration. Neither file
is part of a production application route.

The privacy journey in `scripts/web-live-e2e.ts` is the business E2E gate. It
drives the shipped PWA and, in the isolated Alpha gate, the installed APK over a
disposable encrypted Matrix room and the current Gateway process. It covers
off-by-default binding, required configuration, exact sanitized review, denial,
sanitized Agent egress, local restoration, cross-device/restart history,
extension-offline fail-closed behavior, unbound-session isolation, encrypted
vault/audit storage, and deletion convergence. See
`docs/business-e2e-acceptance.md` for the normative requirements.
