/** Who a hook records as having acted. `[assumption]`: $USER, else "unknown". */
export function currentActor(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? "";
  return user.trim() === "" ? "unknown" : user.trim();
}

/** RFC3339 UTC to the second, the format every tldrx timestamp uses. */
export function nowRfc3339(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}
