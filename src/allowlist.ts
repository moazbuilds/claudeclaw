export function isAllowed<T>(userId: T | undefined, allowedUserIds: T[]): boolean {
  return userId !== undefined && allowedUserIds.length > 0 && allowedUserIds.includes(userId);
}
