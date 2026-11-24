import { z } from 'zod';

export const ResourceTypeSchema = z.enum(['link', 'file']);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const CategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
});
export type Category = z.infer<typeof CategorySchema>;

export const SubcategorySchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
});
export type Subcategory = z.infer<typeof SubcategorySchema>;

export const LinkPreviewSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
  favicon: z.string().nullable(),
  fetchedAt: z.string().nullable(),
});
export type LinkPreview = z.infer<typeof LinkPreviewSchema>;

export const ResourceSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  subcategoryId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  type: ResourceTypeSchema,
  url: z.string().nullable(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  isPinned: z.boolean(),
  sortOrder: z.number().int(),
  updatedAt: z.string(),
  linkPreview: LinkPreviewSchema.nullable().optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const SchoolSettingsSchema = z.object({
  schoolName: z.string(),
  tagline: z.string(),
  announcement: z.string(),
  logoUrl: z.string().nullable(),
  updatedAt: z.string(),
});
export type SchoolSettings = z.infer<typeof SchoolSettingsSchema>;

export const PortalPayloadSchema = z.object({
  settings: SchoolSettingsSchema,
  categories: z.array(CategorySchema),
  subcategories: z.array(SubcategorySchema),
  resources: z.array(ResourceSchema),
});
export type PortalPayload = z.infer<typeof PortalPayloadSchema>;

export const UpdateSettingsInputSchema = z.object({
  schoolName: z.string().trim().min(2, 'School name must be at least 2 characters.').max(120),
  tagline: z.string().trim().max(200).optional().default(''),
  announcement: z.string().trim().max(400).optional().default(''),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

export const LoginInputSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.').max(64),
  password: z.string().min(1, 'Password is required.').max(128),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.').max(128),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export const SafeHttpUrlSchema = z
  .string()
  .trim()
  .url('Please enter a valid web address starting with https:// or http://.')
  .refine(
    (val) => val.startsWith('https://') || val.startsWith('http://'),
    'Link must start with https:// or http://.'
  );

export const CreateLinkResourceInputSchema = z.object({
  categoryId: z.string().min(1, 'Please choose a category.'),
  subcategoryId: z.string().trim().nullable().optional(),
  title: z.string().trim().min(2, 'Title must be at least 2 characters.').max(140),
  description: z.string().trim().max(300).optional().default(''),
  url: SafeHttpUrlSchema,
  isPinned: z.boolean().optional().default(false),
});
export type CreateLinkResourceInput = z.infer<typeof CreateLinkResourceInputSchema>;

export const UpdateResourceInputSchema = z.object({
  categoryId: z.string().min(1).optional(),
  subcategoryId: z.string().trim().nullable().optional(),
  title: z.string().trim().min(2).max(140).optional(),
  description: z.string().trim().max(300).optional(),
  url: SafeHttpUrlSchema.optional(),
  isPinned: z.boolean().optional(),
});
export type UpdateResourceInput = z.infer<typeof UpdateResourceInputSchema>;
