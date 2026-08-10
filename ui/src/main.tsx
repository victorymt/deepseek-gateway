import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { LanguageProvider } from "@/components/language-provider.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { TooltipProvider } from "@/components/ui/tooltip.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="deepseek-gateway-theme">
      <LanguageProvider
        defaultLocale="en"
        storageKey="deepseek-gateway-language"
      >
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </LanguageProvider>
    </ThemeProvider>
  </StrictMode>
)
