/** The signed-in operator performing a record change. */
export type Actor = { userId: string; requestId?: string | null };

export const auditActor = (actor: Actor) => ({ type: "user" as const, userId: actor.userId });
