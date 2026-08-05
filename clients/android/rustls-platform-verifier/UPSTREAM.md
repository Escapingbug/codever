# rustls-platform-verifier Android component

This module vendors the production JVM component from
`rustls-platform-verifier-android` 0.1.1 at upstream commit
`1099f161bfc5e3ac7f90aad88b1bf788e72906cb`.

It is paired with `rustls-platform-verifier` 0.6.2 linked into Matrix Rust SDK
26.07.28. The Matrix SDK AAR omits this required companion component from its
published dependency metadata, so the application must package it explicitly.

Upstream: https://github.com/rustls/rustls-platform-verifier
License: MIT OR Apache-2.0 (this vendored copy uses MIT)

Codever applies the Android CRL selection from upstream PR #179 and permits
cleartext only for Let's Encrypt's `c.lencr.org` CRL host. This preserves
revocation checking for Let's Encrypt certificates without enabling cleartext
application traffic globally.
