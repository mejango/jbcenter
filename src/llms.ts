import {
  directorySections,
  repositoryGroups,
  V6_REPOSITORY,
  workInProgress,
  type DirectoryLink,
} from "./directory.js";

/** The home page's directory as text; capabilities remain a live, separate document. */
export function llmsIndex(audience = "https://juicebox.center"): string {
  const origin = new URL(audience).origin;
  const absolute = (url: string) => new URL(url, `${origin}/`).href;
  const row = ({ need, name, url, code, note, agentNote }: DirectoryLink) =>
    `- [${need}: ${name}](${absolute(url)})${[code && `\`${code}\``, note, agentNote].filter(Boolean).map((part, index) => `${index ? " " : ": "}${part}`).join("")}`;
  return `# Juicebox Center

> The directory for Juicebox V6: apps, guides, APIs, agent tools, audits, and source.
> Protocol reads and unsigned preparation are public; Signa owns wallet approval.

${directorySections.map((section) => `## ${section.title}\n\n${section.links.map(row).join("\n")}`).join("\n\n")}

## Repositories

- [All of V6](${V6_REPOSITORY}): the top-level repository.
${repositoryGroups.flatMap((group) => group.links.map((link) => `- [${link.title}](${link.url}): ${link.description}`)).join("\n")}

## Unfinished

${workInProgress.map(row).join("\n")}

## Evidence and authority

Use chain ID plus project ID to identify a project. Keep protocol version 6 explicit.
Resolve current contracts and re-read transaction dependencies before signing.
Amounts use exact integers in their token's units. Searchable history can lag and is not a snapshot
of one verified block. Unknown reads are not zero or permission.

A bot API grant does not authorize spending wallet funds. Plans are unsigned;
wallet execution requires its own approval. Configured, simulated, submitted, and
verified onchain are different states. A Safe proposal is not execution, and a
receipt on the sending chain does not prove funds arrived on the receiving chain.
Check an uncertain operation by its existing identifiers before retrying. Read live capabilities for
current protocol support instead of assuming it from this index.
`;
}
