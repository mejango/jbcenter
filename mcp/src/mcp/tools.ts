import type { Services } from '../app.js';
import { createProtocolOperations } from '../application/operations.js';
import type { ProtocolOperation } from '../application/operation.js';
import type { ToolDefinition } from './tool.js';

export { preparePlan } from '../application/preparation.js';

/** MCP supplies its own request context and result envelope around the shared handler. */
export function protocolOperationToTool(operation: ProtocolOperation): ToolDefinition {
  return {
    name: `jb_${operation.id}`,
    description: operation.description,
    schema: operation.schema,
    run: operation.handler,
    ...(operation.effects.externalMutation || !operation.effects.idempotent
      ? {
          annotations: {
            readOnlyHint: !operation.effects.externalMutation,
            idempotentHint: operation.effects.idempotent,
            destructiveHint: false,
            openWorldHint: true,
          },
        }
      : {}),
  };
}

export function createTools(services: Services): ToolDefinition[] {
  return createProtocolOperations(services).list().map(protocolOperationToTool);
}
