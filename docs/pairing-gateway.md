# Gateway pairing

The Gateway pairing layer replaces manual token, JWK, Matrix device ID, and
Ed25519 fingerprint copying with a single-use `codever://pair` link.

## Product flow

1. The Gateway loads or creates one persistent P-256 application identity.
2. It creates a signed offer containing its current Matrix route and a
   256-bit, ten-minute-or-shorter secret challenge.
3. The PWA opens the link, displays the Gateway name and six-digit invitation
   check code, and asks the user for one confirmation.
4. The PWA signs a request. The challenge participates in the signature input
   but is deliberately absent from the Matrix request event.
5. The Gateway verifies and atomically consumes the offer and challenge,
   automatically signs a device certificate, persists the device trust record,
   and returns a signed response.

There is no second Gateway approval prompt. Possession of the short-lived QR or
deep-link secret plus the user's one confirmation is the authorization action.
The six-digit code is a display checksum, not the authorization secret.

## Safe PWA links and interrupted pairing

The PWA accepts pairing input only in either of these forms:

- the original `codever://pair?data=...` link carried by a QR code or pasted
  directly into the pairing screen;
- an HTTPS PWA URL whose fragment is `#pair=...`.

The PWA does not accept `?pair=...`. Query strings can be copied into browser
history, referrer headers, reverse-proxy logs, and hosting analytics, while URL
fragments stay client-side. The PWA removes a `#pair` fragment from the visible
URL immediately after reading it. A rejected `?pair` value is also removed
without being processed.

Before the Matrix request is sent, the PWA persists the exact signed offer and
signed request locally. It keeps that pending handshake for ten minutes. After
a refresh or disconnect, the PWA revalidates the documents
at their original signing times and resends the same request ID and Matrix
signed document in a fresh Matrix delivery transaction. The Gateway returns
its persisted response for that exact request instead of approving an expired
request as new. The PWA separately
requires the persisted response to still be within its signed ten-minute
response window. A completed handshake clears the pending record; an expired
record tells the user to scan a new QR code.

Recovery across a Gateway process restart additionally requires the Matrix
crypto device from the offer to persist. The local development Gateway uses a
fresh in-memory Matrix device, so an unfinished local pairing must scan its new
QR. This is a delivery-availability limitation, not a relaxation of
certificate verification.

## Security properties

- Matrix transports only signed protocol documents and never sees the challenge
  carried in the QR/deep link.
- A request is bound to the complete signed offer digest, Gateway ID, device
  application key, Matrix transport identity, requested capabilities, and
  expiry.
- `PairingOfferGuard` consumes the offer ID and challenge atomically in a
  persistent replay store before a certificate is issued.
- The trusted-device registry and Gateway P-256 key survive restarts.
- Revoked devices are rejected by a live registry check before every command.
- Multiple active devices may share a conversation, but never an application
  private key. Reusing one P-256 public key under a second device ID is rejected.
- Gateway output is sealed separately for every active device. Certificates,
  command sequences, acknowledgements and revocation remain device-scoped.
- Durable undelivered copies remain bound to the exact certificate and
  application-key generation that authorized them. Reusing a revoked device ID
  with a new key does not inherit old queued content.
- A new ephemeral Gateway Matrix device can be announced with a rotation
  statement signed by the persistent Gateway P-256 key. The PWA therefore does
  not need to pair again after a Gateway Matrix crypto restart.
- The Gateway also publishes a root-signed current-transport snapshot in its
  `io.codever.gateway_transport` extended Matrix profile field. A PWA that was
  offline across multiple rotations fetches that fixed field, verifies the
  persistent Gateway key and Matrix device fingerprint. Commands use the
  application-encrypted control event path, so they do not wait for a new
  outbound Megolm room key after transport rotation. The profile contains only
  public routing keys and requires homeserver support for `m.profile_fields`;
  it does not require room moderator power.

Protect the directory containing `gateway-identity.json`; it contains the
Gateway private application key. Unix systems set the identity file to mode
`0600`. Windows relies on the directory's ACL.

## Matrix transport adapter

`PairingTransport` is deliberately transport-neutral. A Matrix adapter should:

- accept only `io.codever.kind = "pairing_request"` and pass
  `io.codever.pairing_request` to `attachPairingTransport`;
- send the returned value as
  `io.codever.kind = "pairing_response"` /
  `io.codever.pairing_response`;
- publish signed Gateway device rotations before using a replacement Matrix
  device identity;
- publish the root-signed current transport in the Gateway user's extended
  Matrix profile after the replacement device is active.

Cryptographic checks never accept Matrix room membership or homeserver claims
as authorization.

## Low-level CLI

The CLI is intended for protocol diagnostics and headless integration. The
normal desktop product should render the returned link as a QR code through the
injectable `PairingCodeRenderer`.

```powershell
npx tsx scripts/matrix-pairing-gateway.ts offer `
  --homeserver http://localhost:8008 `
  --room "!room:localhost" `
  --matrix-user "@gateway:localhost" `
  --matrix-device GATEWAY_DEVICE `
  --matrix-ed25519 GATEWAY_ED25519_FINGERPRINT
```

It prints a copyable `codever://pair` link without printing private key
material. State defaults outside the repository under `~/.codever/pairing`.
`list` shows active devices and `revoke --device DEVICE_ID` revokes one locally
trusted application device.

For the local integrated Gateway, set `CODEVER_PAIR_NEW_DEVICE=1` before
starting it to print a short-lived **Add another Codever device** invitation
while existing devices remain active.
