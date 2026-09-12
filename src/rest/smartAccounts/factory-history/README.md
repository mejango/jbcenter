# Complete Safe factory creation prefix

`base.json.gz` is a server-owned, complete index of `ProxyCreation` events from block zero through the recorded finalized Base block, for the factory in the document. `base.sha256` pins its uncompressed bytes. It contains only proxy addresses and block numbers; it contains no keys, sessions, signatures, or wallet authority.

The backfill uses Dwellir's existing archive service, in disjoint ranges of at most 500 blocks. Every batch verifies chain ID 8453. All pages must be present exactly once; errors, malformed events, truncated pages, and a changed finalized anchor abort publication. The retained raw pages are the source for the generation script, not inputs accepted by Center's HTTP API.

At runtime Center rechecks the canonical anchor, fetches the exact indexed creation logs again, and retains its existing canonical receipt, factory transaction, exact CREATE2 initializer, runtime, ownership, module and authority-history verification. An index is discovery evidence, never a substitute for those checks. Duplicate creations remain duplicates and are rejected by the inspector.

PostgreSQL stores subsequent finalized 500-block pages atomically with their watermark. Maintenance advances this tail every 30 seconds. A failed page or changed finalized anchor cannot advance it. Recent unfinalized blocks are always read again. This removes the per-login genesis search without increasing Dwellir's plan or shortening verified history.
