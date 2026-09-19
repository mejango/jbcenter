import {
  pinProjectLogoSchema,
  pinProjectMetadataSchema,
  prepareProjectMetadataSchema,
  type ProjectMetadataService,
} from '../services/metadata.js';
import { operationWithSchema, type ProtocolOperation } from './operation.js';

export function createMetadataOperations(service: ProjectMetadataService): ProtocolOperation[] {
  return [
    operationWithSchema(
      'pin_project_logo',
      'Publish one project logo image to public IPFS using the integrated Center pinning backend and return its ipfs:// logoUri for jb_prepare_project_metadata. Accepts standard base64 of a PNG, JPEG, GIF, WebP or inert SVG file of at most 1 MiB whose bytes match the declared contentType. This is a persistent external mutation; get explicit user authorization for this exact public upload before setting confirmPublicUpload:true. Content may remain public permanently. Does not fetch URLs, resize, pin metadata, use wallet keys, or submit chain transactions. Repeated calls may repeat publication/provider quota consumption.',
      pinProjectLogoSchema,
      async (input) => service.pinLogo(input),
      { externalMutation: true, idempotent: false },
    ),
    operationWithSchema(
      'prepare_project_metadata',
      'Prepare complete new standard Juicebox V6 project metadata for review without uploading anything. Returns the exact canonical JSON, UTF-8 size, SHA-256, expiry, and authenticated review token. Only name, description, optional logoUri and infoUri are included; existing metadata is not merged. URLs and image bytes are never fetched. A review token is not user approval to publish.',
      prepareProjectMetadataSchema,
      async (input) => service.prepare(input),
    ),
    operationWithSchema(
      'pin_project_metadata',
      'Publish the exact document reviewed through jb_prepare_project_metadata to public IPFS using the integrated Center pinning backend. This is a persistent external mutation; get explicit user authorization for this exact public upload before setting confirmPublicUpload:true. A prepare token alone is not approval. Content may remain public permanently. Requires an unexpired authentic review token; does not upload images (use jb_pin_project_logo), fetch URLs, use wallet keys, or submit chain transactions. Repeated calls may repeat publication/provider quota consumption.',
      pinProjectMetadataSchema,
      async (input) => service.pin(input),
      { externalMutation: true, idempotent: false },
    ),
  ];
}
