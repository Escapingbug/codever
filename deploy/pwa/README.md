# PWA production proxy

The production PWA serves a multi-megabyte Matrix Rust Crypto WASM asset.
Caddy must compress that response so a cold mobile connection can initialize
end-to-end encryption before the pairing invitation expires.

Apply the site-level performance directives idempotently:

```sh
chmod +x install-caddy-performance.sh
sudo ./install-caddy-performance.sh
```

The installer enables Zstandard and gzip response encoding and prevents the
versioned Service Worker registration from being hidden by an HTTP cache.

Validate the deployed WASM response with a compression-capable client:

```sh
curl --compressed --head \
  https://rd.anciety.my.id/assets/matrix_sdk_crypto_wasm_bg-DDJzNWwu.wasm
```
