# API documentation sources

`openapi.ts` generates the public specification from the actual operation
descriptors, pinned V6 catalog and Bendystraw schema. `schemas.ts` describes the
HTTP account, read and durable transaction response contracts. `sponsorship.ts`
and `smartAccounts.ts` describe the distinct publication approvals, prepaid
execution observations, wallet bindings and review-only session policies.
`page.ts` renders
escaped static HTML and local CSS without a CDN, scripts or signing prompts.

`openapi-3.1.schema.json` is the unmodified official OpenAPI document-validation
schema from <https://spec.openapis.org/oas/3.1/schema/2025-09-15>, retrieved for
offline specification tests. Its source is the OpenAPI Initiative's
OpenAPI-Specification repository; the accompanying Apache 2.0 license is in
`OPENAPI-LICENSE.txt`. The upstream schema validates OpenAPI document structure;
the tests separately validate generated Schema Objects and local references.
