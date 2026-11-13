# Omnichain projects

A project can run on several chains linked by suckers, the contracts that bridge its tokens and funds. Start from one `(chainId, projectId)` and Center returns the linked projects and each chain's accounting.

```sh
curl 'https://juicebox.center/api/v1/projects/8453/1/omnichain?source=onchain&maxMembers=8'
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `source` | yes | `onchain` or `bendystraw`. Neither falls back to the other |
| `maxMembers` | no | 1 to 8 linked projects |

## Choose a source

| | `onchain` | `bendystraw` |
| --- | --- | --- |
| Finds members by | Following each project's registered suckers | The indexer's sucker group |
| Link verified | Yes, when both sides register each other | No: `linkageVerified: false` |
| Bridge history | Not included | Up to ten recent rows each of bridge transactions, outbox events and claim events per member |
| Freshness | Each chain read at its own block | Indexed, can lag |

## Read the result

- Each member keeps its own owner, controller, token supply, terminal balances and block. Chains are read at different blocks, so the result is not one simultaneous snapshot.
- Balances are never summed across chains, tokens or currencies.
- A peer Center could not verify is listed as unverified and not followed. A member it could not read is `unknown`, not zero.
- Hitting `maxMembers` marks coverage incomplete. It does not mean no other chains exist.

## Bridge movements

A bridged amount passes through separate stages, and the indexer's word for one stage proves nothing about the next:

| Indexed stage | What it does not prove |
| --- | --- |
| Source transaction | That it is final on the source chain |
| `pending` | That the root reached the destination |
| `claimable` | That a claim would succeed now |
| `claimed` | That the destination transaction is final, or that the terminal credited the funds |

Before telling anyone bridged funds arrived, confirm the claim transaction on the destination chain. A source receipt alone can leave funds unclaimed.

## Limits

The request has 60 seconds and a 2 MiB response cap. `completeScope: "membership-discovery"` and `movementHistoryComplete: false` in the response mean the member list is complete but the bridge history is not.
