import type { ToolDefinition } from "@juicebox/mcp/host";

/** The tools the homepage chat may call: reads, quotes and reference only. Nothing that prepares,
 * pins, publishes, deploys, simulates or verifies. Sorted, so the provider's prompt prefix is stable. */
export const CHAT_TOOL_NAMES: readonly string[] = [
  // Reference
  "jb_search_reference", "jb_get_reference", "jb_list_references", "jb_get_contract", "jb_decode_calldata",
  "jb_plan_integration", "jb_get_webclient_reference", "jb_list_webclient_references",
  // Reads
  "jb_resolve_project", "jb_search_projects", "jb_get_project", "jb_get_rulesets", "jb_get_position", "jb_get_account",
  "jb_get_holders", "jb_get_activity", "jb_get_indexer_status", "jb_get_permissions", "jb_get_bridges",
  "jb_get_omnichain_group", "jb_get_routing", "jb_get_721_shop", "jb_get_revnet", "jb_get_loan", "jb_get_intent",
  // Quotes
  "jb_quote_pay", "jb_quote_cash_out", "jb_quote_payout", "jb_quote_721_pay", "jb_quote_loan",
].sort();

export function chatTools(all: ToolDefinition[]): ToolDefinition[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  return CHAT_TOOL_NAMES.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`The chat tool ${name} is missing from the catalog.`);
    return tool;
  });
}
