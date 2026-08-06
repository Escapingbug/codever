# HaS session extension

This is an optional, separately started Codever session extension. It is not
imported by the Gateway or PWA product pipeline, and this directory is outside
the root pnpm workspace on purpose.

It sends plaintext only to a loopback HaS/llama.cpp endpoint, stores mappings
as versioned AES-256-GCM ciphertext, shows the exact sanitized prompt through
Codever's existing decision UI, and restores Agent-visible pseudonyms locally.
If the process, HaS model, preview, mapping commit, or restore path fails, the
turn is blocked rather than sent as plaintext.

Required environment:

- `HAS_EXTENSION_TOKEN`: bearer token shared with the local Gateway (at least
  32 bytes).
- `HAS_PRIVACY_VAULT_KEY`: base64-encoded 32-byte mapping-vault key.
- `HAS_MODEL_REVISION`: immutable model artifact revision or digest.

Optional environment:

- `HAS_ENDPOINT` (default `http://127.0.0.1:18080/v1/chat/completions`)
- `HAS_MODEL` (default `xuanwulab/HaS_Text_0209_0.6B_Q8`)
- `HAS_EXTENSION_PORT` (default `8791`)
- `HAS_PRIVACY_STATE_DIR`
- `HAS_TIMEOUT_MS`

The Gateway registration is local administrator configuration. See
`docs/session-extensions.md` for a complete example.
