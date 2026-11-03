/** What a form's Server Action returns to `useActionState` when it doesn't redirect. */
export type FormState = {
  /** New on every action result. Forms use it as their React key, so they remount with the echoed values as defaults (React resets fields after an action). */
  key?: string;
  ok?: boolean;
  message?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values?: Record<string, string>;
};
