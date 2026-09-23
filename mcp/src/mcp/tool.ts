import type { z } from 'zod';

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
