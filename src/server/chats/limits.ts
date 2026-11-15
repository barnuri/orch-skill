export const MAX_FILE_BYTES: number = 25 * 1024 * 1024;
export const MAX_MESSAGE_BYTES: number = 100 * 1024 * 1024;
/** Largest request body an upload route accepts: one message's worth of files plus multipart framing. */
export const MAX_UPLOAD_REQUEST_BYTES: number = MAX_MESSAGE_BYTES + 1024 * 1024;
export const MAX_CONTENT_CHARS: number = 100_000;
/** Longest chat title, the same cap as ChatRenameDto and ChatInputDto. */
export const MAX_TITLE_CHARS: number = 200;
export const DEFAULT_PAGE: number = 30;
export const MAX_PAGE: number = 100;
export const IDLE_SESSION_MS: number = 30 * 60 * 1000;
