// Ported from BroswerExtension/src/lib/schemas.ts — narrowed; added fieldBase/detectedField schemas.
import { z } from "zod";
import { FIELD_CATEGORIES } from "./types";

export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const fieldCategorySchema = z.enum(FIELD_CATEGORIES);
export const answerTypeSchema = z.enum([
  "text",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "file",
]);

export const savedAnswerSchema = z.object({
  id: z.string().min(1),
  normalizedQuestion: z.string().min(1),
  originalQuestion: z.string().min(1),
  category: fieldCategorySchema,
  answerValue: z.string(),
  answerType: answerTypeSchema,
  optionValue: z.string().optional(),
  sitePattern: z.string(),
  domain: z.string(),
  usageCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  riskLevel: riskLevelSchema,
  notes: z.string(),
  aliases: z.array(z.string()),
});

export const ollamaClassifyResponseSchema = z.object({
  category: fieldCategorySchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const ollamaMatchResponseSchema = z.object({
  matchedAnswerId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  requiresReview: z.boolean(),
});

export const ollamaDropdownResponseSchema = z.object({
  selectedOption: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean(),
  reason: z.string(),
});

export const fieldBaseSchema = z
  .object({
    id: z.string().min(1),
    selector: z.string().min(1),
    tagName: z.string().min(1),
    inputType: z.string(),
    labelText: z.string(),
    normalizedQuestion: z.string(),
    placeholder: z.string(),
    ariaLabel: z.string(),
    name: z.string(),
    idAttribute: z.string(),
    required: z.boolean(),
    options: z.array(z.string()),
    currentValue: z.string(),
    nearbyText: z.string(),
  })
  .strict();

export const detectedFieldSchema = fieldBaseSchema.extend({
  fieldCategory: fieldCategorySchema,
  riskLevel: riskLevelSchema,
  confidence: z.number().min(0).max(1),
});
