import {AsyncLocalStorage} from 'async_hooks';

/**
 * Request-scoped context propagated through AsyncLocalStorage.
 * Allows downstream code (e.g. Mongoose plugins) to access request context
 * without passing it explicitly. Used so soft-delete plugin can include
 * deleted docs for admin on every query (including populate ref queries).
 */
export interface RequestContextStore {
    /** User context from auth middleware (req.body.actionUserCtx). Undefined for public/unauthenticated requests. */
    actionUserCtx?: {
        isAdmin?: boolean;
        userId?: string;
        orgId?: string;
        permissions?: string[];
        isSelf?: boolean;
    };
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();
