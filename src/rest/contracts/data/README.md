# Pinned V6 contract data

`catalog.json` is generated local runtime data. `pins.json` fixes the 22 official
repository commits used to generate it. Experimental extension repositories are
outside this allowlist. The separately included OpenZeppelin forwarder is an
official deployment dependency.

Run from the Center repository with Node 22 or newer:

```sh
node scripts/rest/generate-contracts.mjs --check
node scripts/rest/generate-contracts.mjs
```

`--check` verifies deterministic regeneration without writing. The second command
regenerates from the existing pins. Use `--refresh` only when intentionally advancing
those pins to the local repositories' HEAD commits. `--workspace PATH` selects a
different local checkout; the generator never downloads source or contacts RPCs.

Generation requires the pinned Git objects, compatible Foundry `out` artifacts,
their installed dependency source files, and the matching local Solidity compiler
when an artifact needs recompilation. The compiler defaults to the usual
`~/.svm/<version>/solc-<version>` installation. Repository-owned source comes from
Git, not uncommitted working files. Every compiler source in the closure is checked:
owned files against the pinned commit, dependencies against metadata Keccak hashes.
Missing or mismatched required inputs stop generation.

Contract IDs contain package, source path, and declaration name. The published ABI
is the default; a newer source ABI is a separate variant. Each deployment names its
exact ABI variant. Interfaces, abstracts, libraries, and build scripts remain
discoverable and are not executable targets. Constructor entries remain in ABIs;
only ABI functions become method entries. Library selectors remain unknown where
no compiler method identifier matches the ordinary canonical ABI signature.

All eight supported chains have explicit availability records. Missing deployments
are never filled using another chain, an SDK default, or a source-only build.
Deprecated and TWAP upgrade snapshots and archived source declarations are excluded.

Deployment manifests attest published addresses, receipts, source references, and
artifact hashes. They do not establish current on-chain bytecode. In particular,
clone aliases can contain the implementation's full compiler template. Clone-family
metadata describes factory getters and source patterns; it is not instance proof.

Runtime templates and their immutable masks are separate evidence. Deployment
masks are included only when compiler outputs match the exact runtime, ABI,
compiler settings, and complete source identity of that deployment's metadata.
`immutableReferences: null` means that evidence is unavailable; an empty array means
the matching compiler output declares no immutable spans. Current source-build
evidence is kept separate from deployment evidence. Services must identify their
actual verification level and verify addresses against the requested chain.

SHA-256 code hashes use UTF-8 lowercase `0x`-prefixed hex text, as declared by
`hashEncoding`. Runtime Keccak hashes use bytecode bytes. Artifact hashes use exact
file bytes; ABI and catalog integrity hashes use stable JSON serialization. These
integrity hashes detect accidental changes; the trusted Git pins are the provenance
boundary, and runtime callers cannot replace the catalog or select remote sources.
