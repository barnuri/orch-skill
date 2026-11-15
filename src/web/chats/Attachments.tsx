import { useEffect, useState } from "react";
import { attachmentBlobUrl, downloadAttachment } from "../api/chats";
import { formatBytes, isImageMime } from "../lib/chat-logic";
import type { Attachment } from "../lib/chat-types";

export function useBlobUrl(id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (id !== null) {
      void attachmentBlobUrl(id).then((u) => {
        if (live) {
          setUrl(u);
        }
      });
    }
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}

export function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const url = useBlobUrl(attachment.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={attachment.filename} onClick={onClose}>
      <button type="button" className="lightbox-close icon-btn" aria-label="Close preview" onClick={onClose}>
        ×
      </button>
      {url === null ? <p className="muted">Loading…</p> : <img src={url} alt={attachment.filename} onClick={(e) => { e.stopPropagation(); }} />}
      <p className="lightbox-cap">{attachment.filename} · {formatBytes(attachment.size)}</p>
    </div>
  );
}

/** Image thumbnail (opens the lightbox) or a file chip (downloads). */
export function AttachmentTile({ attachment, onOpen }: { attachment: Attachment; onOpen: (a: Attachment) => void }) {
  const image = isImageMime(attachment.mime);
  const url = useBlobUrl(image ? attachment.id : null);
  if (image) {
    return (
      <button type="button" className="att-thumb" aria-label={`Preview ${attachment.filename}`} onClick={() => { onOpen(attachment); }}>
        {url === null ? <span className="att-thumb-ph" /> : <img src={url} alt={attachment.filename} />}
      </button>
    );
  }
  return (
    <button type="button" className="att-chip" onClick={() => { void downloadAttachment(attachment); }} title="Download">
      <span className="att-name">{attachment.filename}</span>
      <span className="att-size">{formatBytes(attachment.size)}</span>
    </button>
  );
}
