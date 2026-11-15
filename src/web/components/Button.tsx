import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger";
}

export function Button({ variant = "default", className, type = "button", ...rest }: ButtonProps) {
  const klass = ["btn", variant === "default" ? "" : variant, className ?? ""].filter(Boolean).join(" ");
  return <button type={type} className={klass} {...rest} />;
}
