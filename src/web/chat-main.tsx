import "./zod-config";
import "./pwa/head";
import { PwaChrome } from "./pwa/PwaChrome";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { adoptTokenFromUrl } from "./api/token";
import { queryClient } from "./api/queries";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ToastProvider } from "./components/Toast";
import { ChatShell } from "./chats/ChatShell";

adoptTokenFromUrl();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <ConfirmProvider>
        <ChatShell />
        <PwaChrome />
      </ConfirmProvider>
    </ToastProvider>
  </QueryClientProvider>,
);
