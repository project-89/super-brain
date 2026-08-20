import { X } from "lucide-react";
import { type PropsWithChildren, useEffect, useId, useRef } from "react";

interface ModalProps extends PropsWithChildren {
  readonly open: boolean;
  readonly title: string;
  readonly width?: "compact" | "wide";
  readonly onClose: () => void;
}

export function Modal({ open, title, width = "compact", onClose, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={`modal modal--${width}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="modal__surface">
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
