import { z } from 'zod';
import { EnvironmentConfigSchema, PackageNameRegex, PluginAliasSchema, PluginSourceSchema, ProfileNameKeySchema, ProfilePatchSchema } from '../manifest/schema.js';

export const OverlayPatchSchema = z
  .object({
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional()
  })
  .strict();

export const OverlayPluginSchema = z
  .object({
    package: z.string().regex(PackageNameRegex, { message: 'Invalid npm package name format' }).optional(),
    enabled: z.boolean().optional(),
    source: PluginSourceSchema.optional(),
    patches: z.array(OverlayPatchSchema).optional(),
    remove: z.literal(true).optional()
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.remove && Object.keys(val).some((key) => key !== 'remove')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'remove: true cannot be combined with other fields' });
    }
  });

// `{ id, remove: true }` drops the base entry with that id.
export const OverlayProfilePatchSchema = ProfilePatchSchema.refine(
  (entry) => entry.remove === undefined || (entry.remove === true && typeof entry.id === 'string' && Object.keys(entry).length === 2),
  { message: 'remove: true takes only an id' }
);

export const OverlaySchema = z
  .object({
    apiVersion: z.literal('dshenv-overlay/v1'),
    environment: EnvironmentConfigSchema.optional(),
    profiles: z
      .record(
        ProfileNameKeySchema,
        z.object({ plugins: z.record(PluginAliasSchema, OverlayPluginSchema).optional(), patches: z.array(OverlayProfilePatchSchema).optional() }).strict()
      )
      .optional(),
    patches: z.array(OverlayProfilePatchSchema).optional()
  })
  .strict();

export const OverlaySelectionFileSchema = z
  .object({
    apiVersion: z.literal('dshenv-overlay-selection/v1'),
    overlay: z.string().min(1)
  })
  .strict();
