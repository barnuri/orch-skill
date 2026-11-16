import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { getToken } from "../api/token";
import { SECURE_HINT_EVENT, isDismissed, looksLikeInsecureFeature, needsSecureContext, rememberDismissed, showSecureHint } from "./secure-hint";

/** Quiet, dismissable hint. It never blocks anything and shows only after a secure-context feature was tried over plain http. */
export function SecureLinkHint() {
  const [attempted, setAttempted] = useState(false);
  const [dismissed, setDismissed] = useState(isDismissed);
  const eligible = needsSecureContext(location);
  const info = useQuery({
    queryKey: ["server-info"],
    enabled: eligible && !dismissed,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await api.getServerInfo();
      return r.kind === "ok" ? r.body : null;
    },
  });
  useEffect(() => {
    if (!eligible || dismissed) return undefined;
    const on = (): void => setAttempted(true);
    const onError = (e: ErrorEvent): void => void (looksLikeInsecureFeature(e.message ?? "") && on());
    const onReject = (e: PromiseRejectionEvent): void => void (looksLikeInsecureFeature(String((e.reason as Error | undefined)?.message ?? e.reason)) && on());
    window.addEventListener(SECURE_HINT_EVENT, on);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onReject);
    return () => {
      window.removeEventListener(SECURE_HINT_EVENT, on);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, [eligible, dismissed]);

  const url = info.data?.https_url ?? null;
  if (!showSecureHint({ loc: location, attempted, dismissed, hintEnabled: info.data?.secure_link_hint !== false, httpsUrl: url })) return null;
  const token = getToken();
  const href = `${url}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`;
  const trust = info.data?.trust_path === null || info.data?.trust_path === undefined ? null : new URL(info.data.trust_path, url ?? location.href).toString();
  return (
    <div className="secure-hint" role="note">
      <span>Open the secure link to use the microphone: </span>
      <a href={href}>{url}</a>
      {trust === null ? null : (
        <>
          {" "}
          <a href={trust}>/trust</a>
        </>
      )}
      <button
        type="button"
        className="build-link"
        onClick={() => {
          rememberDismissed();
          setDismissed(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
