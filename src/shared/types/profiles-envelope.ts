import type { DocumentEnvelope } from "./document-envelope";
import type { ProfilesDocument } from "./profiles-document";

export interface ProfilesEnvelope extends DocumentEnvelope<ProfilesDocument> {
  harnesses: string[];
}
