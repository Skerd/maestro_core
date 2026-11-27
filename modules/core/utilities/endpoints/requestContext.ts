import {AsyncLocalStorage} from 'async_hooks';
import type {ClientSession} from 'mongoose';
import type {ForeignReferenceAllowance} from '@coreModule/database/plugins/tenantReferences';

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
        modules?: string[];
    };
    /**
     * Module whose router (set at mount time by RouteRegistry.applyRoutes) or cron handler (set by the
     * job runner) is running.
     */
    routeModule?: string;
    /** The running router serves a platform list (D160, D195): the platform company may use it without the module. */
    platformListRoute?: boolean;
    /**
     * The company whose data this request or job works on (D16). Set by authMW (private requests),
     * resolveCompanyByOrigin (public requests) and the cron job runner; ownershipPlugin scopes tenant
     * queries to it. See `tenantScope.ts`.
     */
    tenantCompanyId?: string;
    /** Why the current block may reach any company's data (`asCrossTenant`). Set, scoping is off. */
    crossTenantReason?: string;
    /** Reference fields the current block may point at another company's rows (`allowForeignReferences`, D104). */
    foreignReferences?: ForeignReferenceAllowance;
    /** The caller's language, for errors raised below the request handler (e.g. by plugins). */
    languageCode?: string;
    /** Public requests from the portal: the company the page is about (`x-site-company`, slug or id). */
    siteCompany?: string;
    /**
     * Studio preview read in development. The list is not limited to the signed-in
     * company's modules or its own documents.
     */
    studioSample?: boolean;
    /**
     * The open transaction of this request (`transactionHandler`) or job (`runInTransaction`). Side effects
     * queued with `runAfterCommit` (and every `emitNotificationEvent`) wait for it to commit (D06).
     */
    session?: ClientSession;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();
