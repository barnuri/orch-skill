import { useId } from "react";
import type { InputHTMLAttributes } from "react";

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** The styled checkbox. With a `label` it renders the label beside it; without, pass an aria-label. */
export function Checkbox({ label, checked, onChange, id, ...rest }: CheckboxProps) {
  const auto = useId();
  const boxId = id ?? auto;
  const box = (
    <input
      {...rest}
      id={boxId}
      type="checkbox"
      checked={checked}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
    />
  );
  if (label === undefined) {
    return box;
  }
  return (
    <>
      {box}
      <label htmlFor={boxId}>{label}</label>
    </>
  );
}
