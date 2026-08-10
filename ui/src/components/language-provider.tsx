/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

export type Locale = "en" | "zh-CN"

type LanguageProviderProps = {
  children: React.ReactNode
  defaultLocale?: Locale
  storageKey?: string
}

type LanguageProviderState = {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LOCALES: Locale[] = ["en", "zh-CN"]

const LanguageProviderContext = React.createContext<
  LanguageProviderState | undefined
>(undefined)

function isLocale(value: string | null): value is Locale {
  return value !== null && LOCALES.includes(value as Locale)
}

export function LanguageProvider({
  children,
  defaultLocale = "en",
  storageKey = "language",
}: LanguageProviderProps) {
  const [locale, setLocaleState] = React.useState<Locale>(() => {
    const storedLocale = localStorage.getItem(storageKey)
    return isLocale(storedLocale) ? storedLocale : defaultLocale
  })

  const setLocale = React.useCallback(
    (nextLocale: Locale) => {
      localStorage.setItem(storageKey, nextLocale)
      setLocaleState(nextLocale)
    },
    [storageKey]
  )

  React.useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== storageKey) {
        return
      }

      setLocaleState(isLocale(event.newValue) ? event.newValue : defaultLocale)
    }

    window.addEventListener("storage", handleStorageChange)
    return () => window.removeEventListener("storage", handleStorageChange)
  }, [defaultLocale, storageKey])

  const value = React.useMemo(
    () => ({ locale, setLocale }),
    [locale, setLocale]
  )

  return (
    <LanguageProviderContext.Provider value={value}>
      {children}
    </LanguageProviderContext.Provider>
  )
}

export function useLanguage() {
  const context = React.useContext(LanguageProviderContext)

  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider")
  }

  return context
}
