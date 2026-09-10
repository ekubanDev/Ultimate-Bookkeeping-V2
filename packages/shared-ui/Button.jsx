/**
 * Button — shared design-system primitive, used by both /apps/outlet and
 * (later) /apps/admin. Owns: base styling hook points, disabled/loading
 * affordance for slow/offline taps. Does NOT own: what happens on click —
 * that's always passed in via `onClick` from the caller.
 */
export default function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled = false,
  ...rest
}) {
  return (
    <button
      type={type}
      className={`ub-button ub-button--${variant}`}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
