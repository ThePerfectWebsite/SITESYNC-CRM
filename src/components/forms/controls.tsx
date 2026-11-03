"use client";

import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

function describedBy(id: string, hint?: string, error?: string) {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

function HintAndError({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

type SelectFieldProps = React.ComponentProps<"select"> & {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  error?: string;
};

/**
 * Native select, styled like the shadcn input (works without JS and with form data).
 * Controlled internally: React resets uncontrolled fields after a form action,
 * which would lose the operator's choice when the action returns an error.
 */
export function SelectField({
  name,
  label,
  options,
  placeholder,
  hint,
  error,
  className,
  defaultValue,
  value: controlledValue,
  onChange,
  ...props
}: SelectFieldProps) {
  const id = props.id ?? `field-${name}`;
  const [ownValue, setOwnValue] = useState(String(defaultValue ?? ""));
  const value = controlledValue ?? ownValue;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          "h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50",
          className,
        )}
        value={value}
        onChange={(event) => {
          setOwnValue(event.target.value);
          onChange?.(event);
        }}
        {...props}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <HintAndError id={id} hint={hint} error={error} />
    </div>
  );
}

type TextareaFieldProps = React.ComponentProps<"textarea"> & {
  name: string;
  label: string;
  hint?: string;
  error?: string;
};

export function TextareaField({ name, label, hint, error, ...props }: TextareaFieldProps) {
  const id = props.id ?? `field-${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...props}
      />
      <HintAndError id={id} hint={hint} error={error} />
    </div>
  );
}

export function CheckboxField({
  name,
  label,
  defaultChecked,
  id = `field-${name}`,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  id?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        className="size-4 rounded border-input accent-primary"
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
  variant,
  className,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} className={cn("h-9", className)} disabled={pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}

/** Form-level message (errors that aren't about one field, or a success note). */
export function FormMessage({ message, tone = "error" }: { message?: string; tone?: "error" | "success" }) {
  if (!message) return null;
  return (
    <Alert variant={tone === "error" ? "destructive" : "default"} role={tone === "error" ? "alert" : "status"}>
      {tone === "error" ? <AlertCircle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
