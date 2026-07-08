export interface UserContext {
  userId: string;
  orgId: string;
  isAdmin: boolean;
  permissions: string[];
  isSelf: boolean;
}