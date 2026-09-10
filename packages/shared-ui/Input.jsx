/**
 * Input — shared design-system primitive. Owns: base text/number input
 * styling and label association. Does NOT own: validation rules or
 * form-level state — those live in the feature's own form component/hook
 * (e.g. ExpenseForm.jsx).
 */
export default function Input({
  label,
  id,
  type = "text",
  value,
  onChange,
  placeholder,
  ...rest
}) {
  return (
    <label className="ub-input" htmlFor={id}>
      {label ? <span className="ub-input__label">{label}</span> : null}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        {...rest}
      />
    </label>
  );
}
