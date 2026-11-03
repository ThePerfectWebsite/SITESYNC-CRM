import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FieldProps = React.ComponentProps<"input"> & {
  name: string;
  label: string;
  hint?: string;
  error?: string;
};

/** Labelled input with hint and error text wired up for assistive tech. */
export function Field({ name, label, hint, error, ...inputProps }: FieldProps) {
  const id = inputProps.id ?? `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        className="h-9"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
