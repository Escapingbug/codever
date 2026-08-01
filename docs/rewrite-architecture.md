# Codever Matrix/PWA rewrite

Status: implementation branch

This branch replaces Telegram as Codever's product surface. Matrix is used as an
untrusted encrypted store-and-forward transport. It is not an execution
authority and it is not the source of truth for local agent state.

## Product shape

- Mobile installs the Codever PWA and never runs a Gateway.
- Desktop installs the same web UI together with a local Gateway service.
- A Gateway can also be installed independently on a headless machine.
- One private encrypted Matrix room maps to one Gateway collaboration
  namespace. The Gateway may expose multiple project-scoped agent sessions
  inside that encrypted namespace.
- Existing Matrix clients can transport the room events, but only Codever
  clients can decrypt application content.
- Codever-specific fields add tool cards, decisions, streaming state and
  session controls for the PWA.

## Runtime shape

```text
Codever PWA / enrolled Matrix client
  -> signed Codever command
  -> ECDH/HKDF/AES-GCM secure envelope
  -> Matrix-encrypted room event containing only ciphertext
  -> MatrixTransport
  -> application signature + AEAD + replay check
  -> Codever execution authorization
  -> app-session lookup by signed sessionId
  -> that session's SemanticSessionRuntime
  -> AgentProvider / ACP
  -> ConversationEvent
  -> signed application secure envelope
  -> MatrixPort / encrypted Matrix room event
```

Matrix delivery is append-only from the Gateway's perspective. Edits,
redactions, membership changes and power-level changes never directly mutate
local execution state.

## Room model

Each Gateway collaboration namespace owns one private encrypted room. The
Matrix room ID is a transport locator, not a Codever project or session
identity. A local binding record maps:

```text
conversationId <-> roomId <-> gatewayId
                              └─ app session A
                              │    ├─ projectId <-> cwd
                              │    └─ TopicSession <-> provider session
                              └─ app session B
                                   ├─ projectId <-> cwd
                                   └─ TopicSession <-> provider session
```

Project identity is the pair `(gatewayId, projectId)`. Project display names
are intentionally non-unique; the Gateway derives a stable `projectId` from
the local working directory, so two different paths may both be displayed
with the same project name. Each app session persists its own project, model,
reasoning effort, provider-session binding and archive state.

An app session is an independently live execution address, not a saved profile
that is installed into one room-level runtime when selected:

- every active app session owns its own `TopicSession`,
  `SemanticSessionRuntime`, provider instance and fixed-session `MatrixPort`;
- an archived app session retains its metadata and provider-session binding but
  releases those runtime resources until a signed restore command recreates
  them;
- prompt, cancel, decision and settings commands carry the target `sessionId`;
- archive, restore and delete are signed, revision-checked Gateway mutations.
  Delete removes the app-session record from Codever, but does not claim to
  redact append-only Matrix history or data retained by the provider;
- sessions may run and receive provider events concurrently;
- output remains tagged with the runtime's immutable app-session ID, including
  delayed edits, decisions and status events;
- selecting a conversation is PWA-local view state. It changes which history
  is displayed and never sends a Gateway mutation or suspends another session.

The Gateway intentionally has no mutable “current app session”. Legacy
authoritative-state fields are emitted only as `current_session_id: null` and
`can_select_session: false` during protocol migration.

Sensitive business data must not be written to unencrypted Matrix state:

- repository or workspace paths;
- prompts, agent output or tool arguments;
- provider-native session IDs;
- provider credentials;
- execution authorization keys.

Room names and topics use non-sensitive fallback values. The PWA derives real
display data from encrypted Codever events.

## Protocol layers

1. Standard Matrix content contains only a non-sensitive placeholder.
2. A signed Codever secure envelope encrypts the complete message content with
   a key derived from the paired P-256 application identities.
3. The decrypted `io.codever.*` content provides structured PWA rendering.
4. A Codever authorization envelope binds an exact mutation to a locally
   enrolled device, Gateway and conversation.
5. Stable envelope/command IDs and persistent replay ledgers make redelivery
   idempotent.
6. A room may contain multiple independently enrolled PWA devices. Gateway
   output is fanned out as one P-256 envelope per recipient; there is no shared
   application decryption key.
7. Each device owns an independent command sequence, while a durable
   conversation revision provides cross-device compare-and-swap ordering.
   Stale concurrent mutations are rejected and shown for user review; only an
   explicit confirmation creates a new signature against the revision returned
   by the Gateway.
8. Gateway fan-out is staged in a durable, certificate-bound per-recipient
   outbox before older gaps are recovered or any network attempt begins. The
   first recipient confirmation completes the logical send; remaining copies
   continue in the background. Before matrix-js-sdk, one Gateway-wide scheduler
   reserves a lane for acknowledgements, command results, revision conflicts,
   decisions and history pages; normal fan-out is admitted with bounded
   concurrency (at most two Matrix SDK calls) and durable recovery is globally
   serial and lower priority. A recipient
   watchdog bounds only the caller's wait: the raw transport promise remains
   in-flight until it really settles, so a timeout cannot submit the same stable
   Matrix transaction twice. Queued replacements and Gateway/status snapshots
   use last-write-wins coalescing and leave a durable `superseded` tombstone.
9. Each PWA Matrix device persists its `/sync` checkpoint separately. Offline
   device-list changes can therefore be caught up before a Gateway-signed
   transport rotation is pinned; the sync checkpoint itself grants no trust.
   If incremental rotations fell outside the local timeline, the PWA fetches
   the Gateway's root-signed current transport from its fixed extended Matrix
   profile field before it verifies the Matrix device and sends a command.
10. Late-joining devices recover transcripts through a read-only, expiring
   request inside the authenticated application envelope. The Gateway pages
   canonical logical events from its durable delivery outbox into one
   byte-bounded history page (48 KiB target, 256 KiB hard maximum). Pages up to
   20 KiB travel inline in one application-encrypted Matrix event; larger pages
   use one AES-GCM-encrypted Matrix media object whose size and hashes are bound
   by that event. Stable logical event IDs preserve edit relationships without
   manufacturing a Matrix timeline event for every recovered item. The PWA
   verifies the whole batch before parsing, caches pages locally, coalesces
   concurrent reads of the same cursor, and loads older pages lazily. A UI
   timeout does not discard the protocol request: retries attach to the same
   request until its signed expiry, and a late page is persisted even when the
   user has switched sessions. History media verification runs on a separate
   serial lane after envelope authentication so a slow download cannot block
   command acknowledgements or invitation results. Cursor advancement uses the
   request's original `before` value as a compare-and-swap guard. Replayed
   decisions are display-only and history reads never consume a command
   sequence or advance the conversation revision. During rolling upgrades, a
   request without the byte-limit capability retains the legacy per-event
   response so an already-installed PWA is not broken before its worker updates.

Device invitation UI observes the terminal result independently from the
command acknowledgement. If the acknowledgement wait times out, the PWA keeps
watching the same command ID and coalesces repeated clicks instead of issuing a
second offer. The short-lived Matrix login token is requested only after the
Gateway invitation succeeds, so Gateway queueing cannot consume the token's
useful lifetime; both the pending observation and rendered link are cleared at
their explicit expiry.

## Attachment and artifact flow

Matrix media is storage only. Codever encrypts every attachment with a fresh
AES-256-GCM key before upload, then carries the `mxc://` locator, key, IV,
ciphertext hash, plaintext hash, name, MIME type and bounded size inside the
signed application secure envelope. Matrix never receives a Gateway local path
or a plaintext filename.

For PWA-to-agent input:

1. The PWA encrypts and uploads the selected file.
2. The signed prompt binds its structured attachment descriptor.
3. The Gateway downloads only the signed `mxc://` object, enforces count and
   size limits, authenticates/decrypts it, and verifies the plaintext hash.
4. Images and audio become ACP rich-content blocks. Other files are written to
   a private content-addressed Gateway cache and exposed to the provider as a
   local uploaded-file reference.

For agent-to-PWA output, `send_file` remains the explicit delivery signal.
`MatrixPort` reads the already-authorized local file, encrypts/uploads it, and
places the structured descriptor in the application-encrypted message. The PWA
can then decrypt an image preview or download the original bytes. Telegram-only
`/file_f1` hints are disabled for the first-party Matrix client; incidental
`file://` text is not treated as permission to exfiltrate a local file.

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
