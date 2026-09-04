import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";

import App from "./App";
import ClerkBrain from "./ClerkBrain";
import "./styles.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {clerkPublishableKey === undefined || clerkPublishableKey.length === 0
      ? <App />
      : <ClerkProvider publishableKey={clerkPublishableKey}><ClerkBrain /></ClerkProvider>}
  </StrictMode>,
);
