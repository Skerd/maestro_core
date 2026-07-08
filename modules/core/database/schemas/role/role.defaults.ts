export const defaultRoles: any[] = [
    {
        name: "SysAdmin",
        slug: "sys_admin",
        isAdmin: true,
        isSignupDefault: false,
        canEdit: false,
        canDelete: false
    },
    {
        name: "General Administrator",
        slug: "general_administrator",
        isAdmin: true,
        isSignupDefault: false,
        canEdit: false,
        canDelete: false
    },
    {
        name: "Web Client",
        slug: "webclient",
        isAdmin: false,
        isSignupDefault: true,
        canEdit: true,
        canDelete: false
    },
    {
        name: "Agent",
        slug: "agent",
        isAdmin: false,
        isSignupDefault: false,
        canEdit: true,
        canDelete: false
    }
]
