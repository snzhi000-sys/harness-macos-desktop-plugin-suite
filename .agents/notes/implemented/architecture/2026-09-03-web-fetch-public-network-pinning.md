# Agent Note: WebFetch public-network validation and address pinning

Status: implemented

English | [中文](2026-09-03-web-fetch-public-network-pinning.zh.md)

## Problem

The local HTTP WebFetch provider previously validated URL syntax, credentials, redirect origin, time, and size, but passed a model-selected hostname to global `fetch()`. A hostname could therefore resolve directly to a private service, return a mixed public/private answer set, or change between validation and connection. IPv6 DNS64/NAT64 can also hide a private IPv4 destination behind an apparently global IPv6 address.

This policy belongs only to model-callable WebFetch. Better Sidebar's Browser renders addresses explicitly entered by the user and retains its independent browser permissions; it must not reuse this provider's decision or expose its broader interactive browsing behavior to the model tool.

## Decision

`web-fetch-http` now validates and pins every request hop:

1. Basic URL policy accepts only HTTP(S), rejects embedded credentials and Unix-socket schemes, and preserves the configured URL-length limit.
2. `resolvePublicAddresses()` resolves the complete answer set. Any malformed, empty, or non-public member rejects the whole destination fail closed.
3. IPv4, IPv6, and IPv4-mapped IPv6 are classified with `ipaddr.js`. Loopback, private, link-local, CGNAT, documentation, multicast, broadcast, unspecified, and reserved ranges are rejected.
4. When IPv6 answers are present, RFC 7050 discovery identifies network-specific RFC 6052 DNS64 prefixes. A matching destination whose embedded IPv4 address is non-public is rejected.
5. A request-private Undici `Agent` receives only the validated addresses through `createPinnedLookup()`. The URL hostname is unchanged, preserving HTTP Host and TLS SNI while preventing a second DNS lookup.
6. Every same-origin redirect repeats URL validation, complete resolution, NAT64 checks, and pinning. Cross-origin redirects remain blocked before the target is resolved or contacted and require a new tool call.

The provider intentionally does not adopt upstream's proxy path. A proxy that resolves the origin could map a public hostname to a private address beyond the local validator's view. Until a proxy design can prove equivalent destination validation, model WebFetch uses strict pinned direct transport.

## Alternatives considered

- Copy the latest upstream proxy-aware provider unchanged. Rejected because proxy-side DNS cannot currently prove that the selected origin remains public.
- Check only URL strings or IP literals. Rejected because ordinary hostnames, mixed DNS answers, rebinding, and NAT64 remain exploitable.
- Validate DNS and then call global `fetch()`. Rejected because the transport would perform a second uncontrolled lookup.
- Apply the same restriction to Better Sidebar Browser. Rejected because user-driven interactive browsing and model-selected network access are different authority boundaries.

## Consequences

Model WebFetch now fails closed for private and ambiguous destinations and creates one dispatcher per hop, adding DNS validation and connection-pool setup cost. Direct proxy compatibility is intentionally absent. Existing URL, timeout, size, decoding, and same-origin redirect behavior remains stable. Better Sidebar Browser is unaffected, and the product continues to ship with model Fetch disabled until channel-specific enablement is designed and accepted.

## Product assembly boundary

The product Profile still has `fetch: false` and does not mount a Fetch Provider. Dev and Stable currently share the same Profile source, so Stage 4 does not alter that shared configuration. Enabling WebFetch in a distributable Dev channel requires a future channel-specific Profile composition mechanism; Stable enablement remains a separate product and security decision.

## Verification contract

Tests use only controlled resolver functions and a loopback HTTP fixture reached through injected pinned addresses. Production resolution is covered for public/non-public classification, mixed answers, empty and malformed answers, cancellation, IPv4-mapped IPv6, and DNS64/NAT64. Transport tests prove that same-origin redirects resolve every hop and cross-origin redirects never resolve or connect to the second origin. No test contacts a real private network service.

Any later change must preserve complete-answer-set validation, per-hop revalidation, original-hostname SNI/Host behavior, private dispatcher disposal, and the separation from Better Sidebar Browser permissions.
