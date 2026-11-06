import { z } from 'zod'
const actor = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})(?:\[bot\])?$/)
export const AdmissionRowSchema = z.object({ listedUnaddressed: z.enum(['inferred', 'ignore']).optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: z.enum(['inferred', 'ignore']).optional() }).strict()
export const GitHubConfigSchema = z.object({
  enabled: z.boolean().default(false),
  repository: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/).refine(v => !['.', '..'].includes(v.split('/')[1])),
  botLogin: actor,
  allowedActors: z.array(actor).max(200).default([]), allowedBots: z.array(actor).max(100).default([]),
  admission: z.partialRecord(z.enum(['issues', 'pulls', 'comments', 'ci']), AdmissionRowSchema).default({}),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  observe: z.object({ issues: z.boolean().default(false), pulls: z.boolean().default(false), comments: z.boolean().default(false), ci: z.boolean().default(false) }).strict().default(() => ({ issues: false, pulls: false, comments: false, ci: false })),
}).strict()
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>
export const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
