# User journeys

| Outcome | Center path | Next owner |
| --- | --- | --- |
| Find a project | Directory, indexed project reads or MCP search | App displays source and freshness |
| Inspect current configuration | Canonical project/contract reads | User or agent interprets evidence |
| Prepare a payment or management action | Operation catalog, then unsigned preparation | Signa or an external wallet validates and approves |
| Check a linked project group | Explicit-source omnichain view | Each chain retains its own accounting and settlement evidence |
| Publish a project before deployment | Signed project-intent flow | Center stores the immutable envelope |
| Deploy a published project | Existing bounded intent sponsor, or self-paid transaction | Center verifies exact deployment evidence |
| Publish metadata | Approved browser upload or explicitly reviewed MCP publication | IPFS content is public and potentially persistent |
| Manage identity, devices or app permissions | [Signa](https://signa.center) | Signa owns account state and recovery |
| Recover an uncertain wallet payment | Original Signa/wallet operation | Submitting service reconciles the original attempt |

## First protocol request

Use the [quickstart](QUICKSTART.md). Center protocol REST reads and preparation need no account or API key. Choose a source explicitly wherever required and preserve returned evidence.

## From intent to project

Follow [project intents](PROJECT_INTENTS.md) for signing, publication, sponsored/self-paid deployment and recording. Its signature and funding rules remain separate from public protocol reads.

## From draft to execution

Follow [transaction preparation](TRANSACTIONS.md). Center's unsigned draft provides exact calls. Signa owns grants, approval, execution and recovery; a successful preparation is not a transaction or an approval.

## Develop an integration

Use [contract catalogs](CONTRACTS.md), [indexed reads](INDEXER.md), [the API](API.md) and [agent guidance](AI_GUIDE.md). Prefer existing SDK builders for reusable client-side protocol code. Center's hosted services provide shared data and preparation without copying its server into an application.
