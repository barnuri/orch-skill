export const DOCUMENT_KINDS = {
  profiles: "profiles.json",
  memory: "memory.json",
  suggestions: "suggestions.json",
} as const;

export type DocumentKind = keyof typeof DOCUMENT_KINDS;
