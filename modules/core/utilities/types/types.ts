export interface UserContext {
  userId: string;
  orgId: string;
  isAdmin: boolean;
  permissions: string[];
  isSelf: boolean;
  /** The company's effective modules (set by authMW). */
  modules?: string[];
}