export const DOCUMENT_KINDS = { profiles: "profiles.json", memory: "memory.json" } as const;

export type DocumentKind = keyof typeof DOCUMENT_KINDS;
