import {registerRoomDisplayNames} from "@coreModule/websocket/roomRegistry";

/**
 * Core panel / system rooms. Feature modules register their own under
 * `{module}/websocket/roomContribution.ts`.
 *
 * Keep in sync with:
 * - sinfonia core sidebarContribution + entryPoint/routeConfig
 * - PATH_ROOM_OVERRIDES / SYSTEM_SETTINGS_ROOMS in resolveSiteRoom.ts
 */
export function registerCoreRoomContributions(): void {
    registerRoomDisplayNames({
        // Infrastructure / legacy
        serverHealth: "Server health",
        serverStats: "Server stats",
        mongoData: "MongoDb Online Data",
        webSocketData: "WebSocket Online Data",
        allUsersList: "All users list",
        createNewUser: "Create new user",
        allChats: "All chats",
        siteActivity: "Site activity",
        activity: "Activity",
        // Panel sites (company / account / tenancy)
        home: "Home",
        administration: "Administration",
        users: "Users",
        chats: "Chats",
        company: "Company",
        account: "Account",
        security: "Security",
        notifications: "Notification settings",
        notificationCenter: "Notification center",
        connectedApps: "Connected apps",
        serverPerformance: "Server performance",
        // System settings
        companies_configurations: "Companies configurations",
        roles_configurations: "Roles configurations",
        country_configurations: "Countries configurations",
        states_configurations: "States configurations",
        cities_configurations: "Cities configurations",
        currencies_configurations: "Currencies configurations",
        smtpServers_configurations: "SMTP servers configurations",
        messagingProviders_configurations: "Messaging providers configurations",
    });
}
