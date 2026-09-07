import type { ProjectMetadataService } from '../services/metadata.js';
import { createMetadataOperations } from '../application/metadata.js';
import { protocolOperationToTool } from './tools.js';
import type { ToolDefinition } from './tool.js';

export function createMetadataTools(service: ProjectMetadataService): ToolDefinition[] {
  return createMetadataOperations(service).map(protocolOperationToTool);
}
