/**
 * Modal — shared design-system primitive. Owns: overlay/dismiss chrome
 * (backdrop click, close button, open/closed rendering). Does NOT own: the
 * content inside it, or any submit/save logic — callers like
 * CheckoutModal.jsx and AdjustmentModal.jsx supply that as children.
 */
export default function Modal({ isOpen, onClose, title, children }) {
  if (!isOpen) return null;

  return (
    <div className="ub-modal-backdrop" onClick={onClose}>
      <div className="ub-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ub-modal__header">
          {title ? <h2>{title}</h2> : null}
          <button
            type="button"
            className="ub-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="ub-modal__body">{children}</div>
      </div>
    </div>
  );
}
