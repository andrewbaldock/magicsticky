import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

// A mobile-correct bottom-sheet modal: locks background scroll (iOS-safe), moves focus in + restores
// it, closes on Escape and backdrop tap. Shared by the Connect and Settings sheets so the modal
// behavior lives in one place. `onClose` fires on backdrop/Escape/X; pass `guardClose` to veto a
// backdrop dismiss (e.g. while a one-time secret is shown).
export function Sheet({
  title,
  onClose,
  guardClose,
  children,
}: {
  title: string;
  onClose: () => void;
  guardClose?: () => boolean; // return true to PREVENT a backdrop-tap close
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    ref.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY);
      (restoreFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={() => (guardClose?.() ? undefined : onClose())}>
      <div
        className="sheet"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
