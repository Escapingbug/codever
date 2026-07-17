# Codever security protocol v2

## Trust boundary

Relay is an authenticated router, not an endpoint for Client↔Gateway business content. It can observe connection timing, Gateway IDs, tunnel IDs, sizes, and availability. It cannot decrypt or forge inner messages.

## Direct Relay links

Client↔Relay and Gateway↔Relay use OPAQUE pairing followed by a high-entropy OPAQUE credential. The derived session key protects independent AES-256-GCM records. Each record has a random 96-bit nonce and authenticated channel/message identifiers; there is no shared receive sequence that can be desynchronized by a delayed frame.

These outer links authorize Relay operations and protect routing metadata when TLS is unavailable. TLS is still recommended for defense in depth and traffic-metadata privacy.

## Gateway device pairing

1. Gateway opens a one-time OPAQUE pairing ticket. The ticket expires after three minutes and permits a bounded number of attempts.
2. Client generates an X25519 key pair locally and completes OPAQUE through Relay's opaque tunnel.
3. The OPAQUE session key protects a temporary provisioning channel.
4. Gateway sends its HPKE public key and key ID through that channel.
5. Client sends its HPKE public key and key ID through the same channel.
6. Gateway stores the Client public key; Client stores its private key and the pinned Gateway public key in the platform secret store.
7. The pairing ticket and temporary provisioning cipher are discarded.

The same credential ID cannot silently replace an existing public key. A changed or lost key requires a fresh pairing.

## Normal Client↔Gateway messages

Every tunnel begins with an HPKE-authenticated `device.bind`/`gateway.bound` exchange. No OPAQUE password login is performed after initial pairing.

Business frames use RFC 9180 Auth mode with:

- DHKEM(X25519, HKDF-SHA256)
- HKDF-SHA256
- AES-128-GCM

Each envelope independently carries and authenticates:

- protocol and cipher-suite versions;
- message ID;
- sender and recipient identities;
- sender and recipient key IDs;
- creation and expiry times;
- the HPKE encapsulated key and ciphertext.

Messages can therefore be decrypted out of order without changing a connection-wide cipher state. The default envelope lifetime is five minutes with a bounded future-clock allowance.

## Replay, retry, and revocation

Gateway caches the encrypted response for recently seen message IDs. Re-delivery returns that response without executing the request again. The durable request ledger separately uses the business `idempotencyKey`, so reconnecting with a new encrypted message cannot repeat a completed mutation.

Gateway checks the credential repository before each request and event send. Revoking a device prevents further commands on already-open tunnels as well as new tunnels.

## Persisted secrets

Gateway persists its OPAQUE pairing setup, X25519 private key, and authorized Client public keys in a file written with owner-only permissions. Client persists its X25519 private key and pinned Gateway public key through the platform secret-store abstraction. Relay never receives either endpoint's inner private key.

This protocol intentionally does not read the earlier v1 device credential format. Existing preview installations must pair again.
