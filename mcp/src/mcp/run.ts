import { z } from 'zod';
import { inputJsonSchemaOf } from '../application/operation.js';
import { withRequestBudget } from '../domain/context.js';
import { DomainError, publicError } from '../domain/errors.js';
import { assertUnambiguousJson, jsonSafe } from '../domain/json.js';
import type { ToolDefinition } from './tool.js';

const MAX_RESULT_BYTES = 512 * 1024;
export const toolResultSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string(),
  ok: z.boolean(),
  data: z.json().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      details: z.json().optional(),
    })
    .optional(),
});
export type ToolResult = z.output<typeof toolResultSchema>;

function toolError(error: unknown) {
  if (error instanceof z.ZodError)
    return {
      code: 'INVALID_INPUT',
      message: 'Tool arguments failed validation.',
      retryable: false,
      details: error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  if (error instanceof RangeError)
    return {
      code: 'REFERENCE_NOT_FOUND',
      message:
        'The requested reference or page is unavailable. Use the reference catalog to choose a valid ID and offset.',
      retryable: false,
    };
  return publicError(error);
}

/**
 * Runs one tool under a request budget and returns the versioned envelope. Never throws.
 * The tool's own handler checks its input.
 */
export function runTool(
  tool: ToolDefinition,
  input: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<ToolResult> {
  return withRequestBudget(async () => {
    try {
      const data = jsonSafe(await tool.run(input));
      assertUnambiguousJson(data);
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_RESULT_BYTES)
        throw new DomainError(
          'RESULT_TOO_LARGE',
          'The result exceeded the tool response limit. Request a smaller page or a specific function/reference.',
        );
      return toolResultSchema.parse({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        ok: true,
        data,
      });
    } catch (error) {
      return toolResultSchema.parse({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        ok: false,
        error: jsonSafe(toolError(error)),
      });
    }
  }, options.signal);
}

/** The JSON Schema a model provider receives for a tool's input. */
export function toolJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  return inputJsonSchemaOf(tool.schema);
}
