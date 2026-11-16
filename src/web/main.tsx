import "./zod-config";
import "./pwa/head";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { adoptTokenFromUrl } from "./api/token";
import { queryClient } from "./api/queries";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ToastProvider } from "./components/Toast";
import { AppShell } from "./shell/AppShell";

adoptTokenFromUrl();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <ConfirmProvider>
        <AppShell />
      </ConfirmProvider>
    </ToastProvider>
  </QueryClientProvider>,
);
