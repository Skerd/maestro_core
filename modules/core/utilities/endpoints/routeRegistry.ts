/**
 * Route Registry
 * 
 * Automatically discovers and registers route modules from the file system.
 * Eliminates the need for manual route registration.
 */

import {Application, NextFunction, Request, Response, Router} from 'express';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {registerRawBodyPrefix} from '@coreModule/utilities/endpoints/rawBodyRouteRegistry';
import {requestContext} from '@coreModule/utilities/endpoints/requestContext';
import {isPlatformListRouter, recordPlatformListModule} from "@coreModule/utilities/security/platformListRegistry";
import path from 'path';
import fs from 'fs';
import {stripServerKeys} from "@coreModule/utilities/middlewares/serverKeys";
import {failedRequestCleanup} from "@coreModule/utilities/middlewares/failedRequestCleanup";
import {isModuleCodeFile, withoutModuleExtension} from "@coreModule/utilities/modules/moduleCodeFiles";
import {recordRouterMounted} from "@coreModule/utilities/endpoints/recordRegistry";

/**
 * Route Metadata Interface
 */
export interface RouteMetadata {
    path: string;
    methods: string[];
    description?: string;
    requiresAuth?: boolean;
    requiresPermissions?: string[][];
    rateLimited?: boolean;
}

/**
 * Route Module Interface
 */
export interface RouteModule {
    router: Router;
    path?: string;
    version?: string;
    basePath?: string;
    metadata?: RouteMetadata;
}

/**
 * Route Registry Class
 */
export class RouteRegistry {
    private routes: Map<string, RouteModule[]> = new Map();
    private metadata: RouteMetadata[] = [];
    private logger?: serverLogger;

    constructor(logger?: serverLogger) {
        this.logger = getLogger("routeRegistry", logger);
    }

    /**
     * Register a route module manually
     */
    register(basePath: string, module: RouteModule): void {
        const routePath = module.path || basePath;
        
        if (this.routes.has(routePath)) {
            const existingModules = this.routes.get(routePath)!;
            existingModules.push({ ...module, basePath: routePath });
            this.logger?.debug(`Merged route: ${routePath} (${existingModules.length} routers)`);
        } else {
            this.routes.set(routePath, [{ ...module, basePath: routePath }]);
            this.logger?.debug(`Registered route: ${routePath}`);
        }
    }

    /**
     * Auto-discover routes from the directory structure
     */
    async discoverRoutes(directory: string, basePath: string = '/api'): Promise<void> {
        this.logger?.start("Discovering routes...");

        if (!fs.existsSync(directory)) {
            this.logger?.err(`Directory does not exist: ${directory}`);
            return;
        }
        
        await this._discoverRoutesRecursive(directory, basePath, '');
        this.logger?.finish("Finished discovering routes!");
    }

    /**
     * Recursively discover routes in the directory
     */
    private async _discoverRoutesRecursive(
        directory: string,
        basePath: string,
        relativePath: string
    ): Promise<void> {
        try {
            const files = fs.readdirSync(directory, { withFileTypes: true });

            for (const file of files) {
                const fullPath = path.join(directory, file.name);
                const newRelativePath = relativePath 
                    ? `${relativePath}/${file.name}` 
                    : file.name;

                if (file.isDirectory()) {
                    if (!this._isSkippedDirectory(file.name)) {
                        await this._discoverRoutesRecursive(fullPath, basePath, newRelativePath);
                    }
                } else if (this._isRouteFile(file.name)) {
                    await this._loadRouteFile(fullPath, basePath, newRelativePath);
                }
            }
        } catch (error: any) {
            this.logger?.err(`Error discovering routes in ${directory}`, error);
        }
    }

    /**
     * Directories under `modules/<name>/api` that are not route modules.
     * `_tests` must be skipped: importing a Vitest file from the CJS server fails.
     * `__tests__` stays in the skip list so an old folder name is not loaded either.
     */
    private _isSkippedDirectory(name: string): boolean {
        return name === "middleware" || name === "_tests" || name === "__tests__" || name === "__mocks__";
    }

    /**
     * Check if the file is a route file
     */
    private _isRouteFile(filename: string): boolean {
        return isModuleCodeFile(filename);
    }

    /**
     * Load and register a route file
     */
    private async _loadRouteFile(
        filePath: string,
        basePath: string,
        relativePath: string
    ): Promise<void> {
        try {
            const importPath = withoutModuleExtension(filePath);
            const routeModule = await import(importPath);
            
            if (routeModule.router) {
                const routePath = this._determineRoutePath(relativePath, basePath, routeModule);
                const moduleWithPath = {
                    router: routeModule.router,
                    path: routePath,
                    version: routeModule.version,
                    basePath: routePath,
                    metadata: routeModule.metadata
                };
                this.register(routePath, moduleWithPath);

                if (routeModule.needsRawBody === true) {
                    registerRawBodyPrefix(routePath);
                    this.logger?.debug(`Registered rawBody prefix: [${routePath}]`);
                }
                
                if (routeModule.metadata) {
                    this.metadata.push({
                        ...routeModule.metadata,
                        path: routePath
                    });
                }
                
                this.logger?.debug(`Loaded route: [${routePath}] from ${filePath}`);
            } else {
                this.logger?.debug(`File ${filePath} does not export a router`);
            }
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            const errorStack = error?.stack || '';
            const importPath = withoutModuleExtension(filePath);
            
            this.logger?.err(
                `Failed to load route file: ${filePath}\n` +
                `Import path: ${importPath}\n` +
                `Error: ${errorMessage}\n` +
                (errorStack ? `Stack: ${errorStack.substring(0, 500)}...\n` : ''),
                error
            );
        }
    }

    /**
     * Determine the route path from the file structure
     */
    private _determineRoutePath(
        relativePath: string,
        basePath: string,
        module: any
    ): string {
        let routePath = withoutModuleExtension(relativePath);
        routePath = routePath.replace(/\/index$/, '').replace(/^index$/, '');
        routePath = routePath.replace(/\/private\/?/g, '/').replace(/\/public\/?/g, '/');
        routePath = routePath.replace(/\/+/g, '/');
        routePath = routePath.replace(/^\/+|\/+$/g, '');
        
        let finalPath = routePath 
            ? `${basePath}/${routePath}` 
            : basePath;
        
        const customPath = module.basePath || module.path;
        if (customPath) {
            return customPath;
        }
        
        return finalPath;
    }

    /**
     * Apply all registered routes to Express application. Every request reaching one of the
     * routers is tagged with `moduleName` (request context `routeModule`), which authMW and
     * the public company resolver check against the company's modules. A router that falls
     * through leaves the next mount to re-tag the request.
     */
    applyRoutes(app: Application, moduleName: string): void {
        const tagRouteModule = (platformListRoute: boolean) => (_req: Request, _res: Response, next: NextFunction) =>
            requestContext.run({...requestContext.getStore(), routeModule: moduleName, platformListRoute}, () => next());
        const totalRoutes = Array.from(this.routes.values()).reduce((sum, modules) => sum + modules.length, 0);
        this.logger?.start(`Applying ${totalRoutes} routes across ${this.routes.size} paths to Express app...`);
        
        const sortedRoutes = Array.from(this.routes.entries())
            .sort((a, b) => b[0].length - a[0].length);

        sortedRoutes.forEach(([routePath, modules]) => {
            try {
                modules.forEach((module, index) => {
                    // stripServerKeys first: no client value may reach a server-owned body key (SEC-03).
                    // failedRequestCleanup last: whatever step failed, an open transaction rolls back and uploads
                    // that did not are handed to the orphan cleanup (TD-B251).
                    const platformList = isPlatformListRouter(module.router);
                    app.use(routePath, stripServerKeys, tagRouteModule(platformList), module.router, failedRequestCleanup);
                    if (platformList) recordPlatformListModule(moduleName);
                    // Its records can now be shared in chat, gated on this module (D162).
                    recordRouterMounted(module.router, moduleName);
                    if (modules.length > 1) {
                        this.logger?.debug(`Applied route: ${routePath} (router ${index + 1}/${modules.length})`);
                    } else {
                        this.logger?.debug(`Applied route: ${routePath}`);
                    }
                });
            } catch (error: any) {
                this.logger?.err(`Failed to apply route: ${routePath}`, error);
            }
        });

        this.logger?.finish(`Applied ${totalRoutes} routes successfully`);
    }

    /**
     * Get all registered routes
     */
    getRoutes(): Map<string, RouteModule[]> {
        return new Map(this.routes);
    }

    /**
     * Get route count
     */
    getRouteCount(): number {
        return this.routes.size;
    }

    /**
     * Get total router count
     */
    getTotalRouterCount(): number {
        return Array.from(this.routes.values()).reduce((sum, modules) => sum + modules.length, 0);
    }

    /**
     * Clear all registered routes
     */
    clear(): void {
        this.routes.clear();
        this.metadata = [];
    }

    /**
     * Get all route metadata
     */
    getMetadata(): RouteMetadata[] {
        return [...this.metadata];
    }

    /**
     * Get route metadata by path
     */
    getMetadataByPath(path: string): RouteMetadata | undefined {
        return this.metadata.find(m => m.path === path);
    }
}

/**
 * Helper function to create and configure a route registry
 */
export async function createRouteRegistry(
    logger?: serverLogger,
    apiDirectory?: string,
    basePath: string = '/api'
): Promise<RouteRegistry> {
    const registry = new RouteRegistry(logger);
    await registry.discoverRoutes(apiDirectory, basePath);
    return registry;
}

