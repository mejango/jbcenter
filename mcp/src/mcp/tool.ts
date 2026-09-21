import { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject;
  annotations?: ToolAnnotations;
  run(input: unknown): Promise<unknown>;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (input: z.output<z.ZodObject<S>>) => Promise<unknown>,
  annotations?: ToolAnnotations,
): ToolDefinition {
  const schema = z.object(shape).strict();
  return { name, description, schema, annotations, run: async (input) => run(schema.parse(input)) };
}

export function toolWithSchema<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.output<S>) => Promise<unknown>,
  annotations?: ToolAnnotations,
): ToolDefinition {
  return { name, description, schema, annotations, run: async (input) => run(schema.parse(input)) };
}
