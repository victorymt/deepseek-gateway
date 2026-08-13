/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

export type ToastVariant = "success" | "error" | "info"

type ToastItem = { id: number; message: string; variant: ToastVariant }

type ToastContextValue = {
  showToast: (message: string, variant?: ToastVariant) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

export function useToast() {
  const context = React.useContext(ToastContext)
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return context
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const nextId = React.useRef(1)

  const showToast = React.useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = nextId.current++
      setToasts((current) => [...current.slice(-3), { id, message, variant }])
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id))
      }, 4000)
    },
    []
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-viewport" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.variant}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
