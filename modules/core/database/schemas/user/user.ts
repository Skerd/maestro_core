import axios from "axios";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import {Response} from "express";
import speakeasy from 'speakeasy';
import {randomUUID} from "node:crypto";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {IRole} from "@coreModule/database/schemas/role/role";
import {IMedia} from "@coreModule/database/schemas/media/media";
import {ClientSession, ObjectId} from "mongodb";
import {serverLogger} from "@coreModule/loggers/serverLog";
import {IFinance} from "@coreModule/database/schemas/finance/finance";
import {ActionException} from "armonia/src/modules/core/types";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {IUserSession} from "@coreModule/database/schemas/userSession/userSession";
import {applyUserIndexes} from "./user.indexes";
import {Document, model, Schema, SchemaTypes} from "mongoose";
import {isKafkaConnected} from "@coreModule/connections/connectToKafka";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {AUTHENTICATION, CONSTANTS, IP_INFO} from "@coreModule/environment";
import Transaction, {TransactionType} from "@coreModule/database/schemas/transaction/transaction";
import {firstOfMonth, generateRandomString, lastOfMonth} from "@coreModule/utilities/helpers";
import {
    AddToLoginHistory,
    SendActivationEmail,
    SendForgotPasswordEmail,
    SendInvitationEmail,
    SendMfaDisableEmail
} from "@coreModule/utilities/database/user";
import {
    ActivationEmailEvent,
    ForgotPasswordEmailEvent,
    InvitationEmailEvent,
    LoginHistoryEvent,
    MFADisableEmailEvent
} from "@coreModule/kafka/types";
import {
    publishActivationEmailEvent,
    publishForgotPasswordEmailEvent,
    publishInvitationEmailEvent,
    publishLoginHistoryEvent,
    publishMfaDisableEmailEvent
} from "@coreModule/kafka/kafkaProducer";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";
import {addModelData} from "@coreModule/database/collections";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {RoleSimpleSnippet} from "@coreModule/database/schemas/role/role.snippets";

let userService: any;
let roleService: any;
let companyService: any;
let userSessionService: any;

const getServices = async () => {
    if (!userService) {
        const [
            {userService: u},
            {roleService: r},
            {companyService: c},
            {userSessionService: us},
        ] = await Promise.all([
            import("@coreModule/database/schemas/user/user.service"),
            import("@coreModule/database/schemas/role/role.service"),
            import("@coreModule/database/schemas/company/company.service"),
            import("@coreModule/database/schemas/userSession/userSession.service"),
        ]);
        userService = u;
        roleService = r;
        companyService = c;
        userSessionService = us;
    }
    return {userService, roleService, companyService, userSessionService};
};

const findCompanyRole = (roles: IEmbeddedCompanyRole[], companyId: ObjectId): IEmbeddedCompanyRole | undefined => {
    return roles.find((role: IEmbeddedCompanyRole) => {
        const roleCompanyId = role.company?._id || role.company;
        return roleCompanyId?.toString() === companyId.toString();
    });
}

export interface IEmbeddedCompanyRole {

    active: "active" | "inactive" | "invited";
    unsuccessfulLogins: number;
    lockedOutUntil: Date | null;
    lastLogin: Date | null;
    rolesCount: number;
    roles: IRole[];
    company: ICompany;
    _id: ObjectId;
}

export interface IUser extends Document, IOwnershipPluginFields {

    _id: ObjectId,
    username: string,
    password: string,
    registerDate: Date,
    registeredFrom?: IUser,
    mfaStatus: "active" | "notActive",
    mfaSecret: string,
    online: boolean,
    isBot: boolean,
    requests: {
        mfaActivation: {
            secret: string
        },
        mfaDeactivation: {
            code: string,
            attempts: number,
            date?: Date,
            lockedUntil?: Date
        },
        passwordReset: {
            opened: boolean,
            code: string,
            attempts: number,
            date?: Date,
            lockedUntil?: Date
        },
        activation: {
            code: string,
            email: string,
            attempts: number,
            date?: Date,
            lockedUntil?: Date
        },
        telegram: {
            code: string
        },
        invitation: {
            opened: boolean,
            code: string,
            attempts: number,
            date?: Date,
            lockedUntil?: Date,
            invitedBy: IUser,
            invitedAt: Date,
            invitationExpiresAt: Date,
            accepted: boolean,
            acceptedAt?: Date,
            welcomeMessage: string,
            company: ICompany
        }
    },

    name: string;
    surname: string;
    fullName: string;
    timezone: string;
    birthday: Date;
    phoneNumber: string;
    companies: ICompany[];
    finance: IFinance[];
    roles: IEmbeddedCompanyRole[];
    telegramNotify?: boolean;
    telegram: {
        runProtocols: boolean,
        chatId?: number
    };
    photo?: IMedia,
    cover?: IMedia,
    isEmailVerified: boolean,
    emailVerifiedAt?: Date,

    // Methods
    addLoginHistory: (companyId: ObjectId, request: any, error: ActionException | null, session?: ClientSession) => Promise<void>,
    sendActivationEmail: (emailAddress: string, languageCode: string, session?: ClientSession, logger?: serverLogger) => Promise<void>,
    isMfaEnabled: () => boolean,
    verifyMfa: (companyId: ObjectId, mfaCode: string, languageCode?: string) => Promise<void>,
    verifyRequestMfa: (mfaCode: string) => boolean,
    createOrUpdateSession: (
        companyId: ObjectId,
        deviceId: string,
        userAgent: string,
        ipAddress: string,
        response: Response,
        languageCode: string
    ) => Promise<{ session: IUserSession; isNewDevice: boolean }>,
    generateJWTToken: (companyId: ObjectId, audience: "client" | "panel", userSessionId: string, languageCode?: string) => Promise<{token: string, refreshToken: string}>,
    sendDisableMfaEmail: (languageCode: string, session?: ClientSession, logger?: serverLogger) => Promise<void>,
    sendForgotPasswordEmail: (languageCode: string, session?: ClientSession, logger?: serverLogger) => Promise<void>,
    sendInvitationEmail: (welcomeMessage: string, companyName: string, inviterName: string, languageCode: string, companyId: ObjectId, session?: ClientSession, logger?: serverLogger) => Promise<void>,
    checkPassword: (companyId: ObjectId, candidatePassword: string, languageCode: string) => Promise<void>,
    checkAccountAccessibility: (companyId: ObjectId, languageCode: string, session?: ClientSession, logger?: serverLogger) => Promise<void>,
    updateUnsuccessfulLogins: (companyId: ObjectId, session?: ClientSession) => Promise<void>,
    resetUnsuccessfulLogins: (companyId: ObjectId, session?: ClientSession) => Promise<void>,
    getUnsuccessfulLogins: (companyId: ObjectId) => Promise<number>,
    isUserActive: (companyId: ObjectId) => Promise<boolean>,
    changeAccountStatus: (companyId: ObjectId, status: boolean, session?: ClientSession) => Promise<void>,
    getCompanyRolePermissions: (companyId: ObjectId) => Promise<string[]>;
    companyRoleHasPermission: (companyId: ObjectId, permission: string) => Promise<boolean>;
    hasAtLeastOneRole: (companyId: ObjectId) => Promise<boolean>;
    getUserRoles: (companyId: ObjectId) => Promise<IRole[]>;
    getCompanies: () => Promise<{_id: ObjectId, name: string}[]>;
    getCompanyIds: () => Promise<ObjectId[]>;
    isAdmin: (companyId: ObjectId) => Promise<boolean>;
    getTransactionAmounts: (companyId: ObjectId, userId: ObjectId, transactionType: TransactionType, startDate?: Date, endDate?: Date) => Promise<{[key: string]: number}>;

}

const UserSchema = new Schema<IUser>(
    {
        //profile info
        username: {
            type: SchemaTypes.String,
            required: true,
            unique: true
        },
        name: {
            type: SchemaTypes.String,
            required: true,
            trim: true
        },
        surname: {
            type: SchemaTypes.String,
            required: true
        },
        fullName: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        timezone: {
            type: SchemaTypes.String,
            required: true,
            default: "Europe/Berlin",
            dynamicTableConfiguration: {
                visible: false,
            }
        },
        birthday: {
            type: SchemaTypes.Date,
            dynamicTableConfiguration: {
                visible: false,
                cellType: COLUMN_TYPE.DATE
            }
        },
        phoneNumber: {
            type: SchemaTypes.String
        },
        telegram: {
            type: {
                runProtocols: {
                    type: Boolean,
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission",
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission",
                        },
                    },
                },
                chatId: {
                    type: Number,
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission",
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission",
                        },
                    },
                },
            }
        },
        photo: {
            type: SchemaTypes.ObjectId,
            ref: "Media",
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                cellType: COLUMN_TYPE.AVATAR
            }
        },
        cover: {
            type: SchemaTypes.ObjectId,
            ref: "Media",
            dynamicTableConfiguration: {
                visible: false,
                filterable: false,
                sortable: false,
                cellType: COLUMN_TYPE.AVATAR
            }
        },
        isEmailVerified: {
            type: SchemaTypes.Boolean,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {}
            }
        },
        emailVerifiedAt: {
            type: SchemaTypes.Date,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            dynamicTableConfiguration: {
                visible: false
            }
        },
        registeredFrom: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            refAllowlist: SimpleBlankUserSnippet,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            dynamicTableConfiguration: {
                visible: false,
                refDisplayKey: ["name", "surname"]
            }
        },
        registerDate: {
            type: SchemaTypes.Date,
            default: Date.now(),
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },
        online: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },
        isBot: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        companies: {
            type: [SchemaTypes.ObjectId],
            ref: "Company",
            default: [],
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        roles: [{
            type: {
                active: {
                    type: SchemaTypes.String,
                    enum: ["active", "inactive", "invited"],
                    default: "active",
                    dynamicTableConfiguration: {
                        dtoPath: "status"
                    }
                },
                unsuccessfulLogins: {
                    type: SchemaTypes.Number,
                    required: true,
                    default: 0,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {}
                    },
                    dynamicTableConfiguration: {
                        visible: false,
                        dtoPath: "unsuccessfulLogins"
                    }
                },
                lockedOutUntil: {
                    type: SchemaTypes.Date,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {}
                    },
                    dynamicTableConfiguration: {
                        visible: false,
                        dtoPath: "lockedOutUntil"
                    }
                },
                lastLogin: {
                    type: SchemaTypes.Date,
                    required: false,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    },
                    dynamicTableConfiguration: {
                        dtoPath: "lastLogin"
                    }
                },
                rolesCount: {
                    type: SchemaTypes.Number,
                    required: true,
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission"
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission"
                        }
                    }
                },
                roles: {
                    type: [SchemaTypes.ObjectId],
                    ref: "Role",
                    refAllowlist: RoleSimpleSnippet,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {}
                    },
                    dynamicTableConfiguration: {
                        dtoPath: "roles"
                    }
                },
                company: {
                    type: SchemaTypes.ObjectId,
                    ref: "Company",
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission"
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission"
                        }
                    }
                },
            },
            default: []
        }],
        finance: {
            type: [SchemaTypes.ObjectId],
            ref: "Finance",
            default: [],
            dynamicTableConfiguration: {
                visible: false,
                filterable: false,
                sortable: false,
            },
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },

        // security
        password: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    read: "no-permission",
                },
                others: {
                    read: "no-permission",
                }
            }
        },
        mfaStatus: {
            type: SchemaTypes.String,
            enum: ["active", "notActive"],
            default: "notActive",
            dynamicTableConfiguration: {
                visible: false,
            }
        },
        mfaSecret: {
            type: SchemaTypes.String,
            required: false,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        requests: {
            type: {
                mfaActivation: {
                    type: {
                        secret: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            }
                        }
                    },
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission"
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission"
                        }
                    }
                },
                mfaDeactivation: {
                    type: {
                        code: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            }
                        },
                        attempts: {
                            type: SchemaTypes.Number,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        date: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        lockedUntil: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        }
                    }
                },
                passwordReset: {
                    type: {
                        opened: {
                            type: SchemaTypes.Boolean,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        code: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            }
                        },
                        attempts: {
                            type: SchemaTypes.Number,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        date: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        lockedUntil: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        }
                    }
                },
                activation: {
                    type: {
                        code: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            }
                        },
                        email: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    // read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    // read: "no-permission",
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        attempts: {
                            type: SchemaTypes.Number,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        date: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        lockedUntil: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        }
                    }
                },
                invitation: {
                    type: {
                        opened: {
                            type: SchemaTypes.Boolean,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        code: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            }
                        },
                        attempts: {
                            type: SchemaTypes.Number,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        date: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        lockedUntil: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        invitedBy: {
                            type: SchemaTypes.ObjectId,
                            ref: "User",
                            refAllowlist: SimpleBlankUserSnippet,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false,
                                refDisplayKey: ["name", "surname"]
                            }
                        },
                        invitedAt: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        invitationExpiresAt: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        accepted: {
                            type: SchemaTypes.Boolean,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        acceptedAt: {
                            type: SchemaTypes.Date,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {}
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        welcomeMessage: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    write: "no-permission"
                                },
                                others: {
                                    write: "no-permission"
                                }
                            },
                            dynamicTableConfiguration: {
                                visible: false
                            }
                        },
                        company: {
                            type: SchemaTypes.ObjectId,
                            ref: "Company",
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            },
                        }
                    }
                },
                telegram: {
                    type: {
                        code: {
                            type: SchemaTypes.String,
                            permissions: {
                                self: {
                                    read: "no-permission",
                                    write: "no-permission"
                                },
                                others: {
                                    read: "no-permission",
                                    write: "no-permission"
                                }
                            }
                        }
                    }
                }
            }
        },
    },
    {
        permissions: {
            self: {
                delete: "no-permission",
                restore: "no-permission",
            },
            others: {
                delete: "no-permission",
                restore: "no-permission",
            }
        }
    }
);

UserSchema.pre("save", async function (next){
    let user: any = this;

    // if( !user.createdBy ){
    //     user.createdBy = user._id;
    // }

    if( user.isModified("name") || user.isModified("surname") ){
        user.fullName = user.name + " " + user.surname;
    }

    if( !user.isModified( "password" ) ){
        //TODO possible hash attack on reset or password forget
        return next();
    }
    try {
        const salt = await bcrypt.genSalt(AUTHENTICATION.SALT);
        user.password = await bcrypt.hash(user.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

UserSchema.methods.addLoginHistory = async function (companyId: ObjectId, req: any, error: ActionException | null, session?: ClientSession): Promise<void> {

    let loginEvent: LoginHistoryEvent = {
        eventType: "login_history",
        userId: this._id.toString(),
        companyId: companyId.toString(),
        userAgent: req.body?.userAgent ?? req.headers?.['user-agent'] ?? "Unknown",
        requestIP: req.body?.requestIp ?? req.ip ?? "",
        userMfaEnabled: this.isMfaEnabled(),
        timestamp: Date.now(),
        error: error
    }

    if( isKafkaConnected() ){
        publishLoginHistoryEvent(loginEvent).catch((err) => {console.error(`Failed to publish login history to Kafka: ${err.message}`);});
    }
    else{
        try{
            await AddToLoginHistory(loginEvent, session);
        }catch (e){
            // Login history must not block authentication.
        }
    }
}

UserSchema.methods.sendActivationEmail = async function (emailAddress: string, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE, session?: ClientSession, logger?: serverLogger): Promise<void> {

    const now = new Date();

    // Initialize activation fields if they don't exist
    const activationCode = generateRandomString(64);
    let updateUserActivationRequest = {
        "isEmailVerified": false,
        "requests.activation.code": activationCode,
        "requests.activation.email": emailAddress
    }

    let unsetLockedOut = false;
    if( !!this.requests?.activation?.lockedUntil && new Date(this.requests.activation.lockedUntil).getTime() > now.getTime() ){
        throw apiValidationException(
            "activation_link_sent_too_many_times",
            null,
            null,
            languageCode,
            [
                this.requests.activation.lockedUntil.toLocaleString(languageCode, {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: this.timezone
                })
            ]
        );
    }
    else {
        if( !!this.requests?.activation?.lockedUntil ){
            unsetLockedOut = true;
            updateUserActivationRequest["requests.activation.attempts"] = 1;
        }
        else{
            if (!!this.requests?.activation?.attempts && AUTHENTICATION.ACTIVATION_EMAIL_TIMEOUT && this.requests.activation.attempts >= (AUTHENTICATION.ACTIVATION_EMAIL_MAX_ATTEMPTS - 1)) {
                updateUserActivationRequest["requests.activation.lockedUntil"] = new Date(now.getTime() + AUTHENTICATION.ACTIVATION_EMAIL_LOCKOUT_DURATION);
                updateUserActivationRequest["requests.activation.attempts"] = (this.requests.activation.attempts ?? 0) + 1;
            }
            else{
                updateUserActivationRequest["requests.activation.attempts"] = (this.requests?.activation?.attempts ?? 0) + 1;
            }
        }
    }

    const activationCompanyId =
        this.roles?.[0]?.company?._id?.toString() ??
        this.roles?.[0]?.company?.toString();

    const activationEmail: ActivationEmailEvent = {
        eventType: "activation_email",
        email: emailAddress,
        userId: this._id.toString(),
        fullName: this.name + " " + this.surname,
        activationCode: activationCode,
        languageCode: languageCode,
        timestamp: Date.now(),
        companyId: activationCompanyId,
    }

    if (isKafkaConnected()) {
        publishActivationEmailEvent(activationEmail).catch((err) => {console.error(`Failed to publish activation email to Kafka: ${err.message}`);});
    }
    else {
        await SendActivationEmail(activationEmail, session);
    }

    const { userService } = await getServices();
    // Use auditUserId from $locals if set (for public endpoints, this will be the user's own ID for self-action)
    // Otherwise, use the user's own ID as fallback for self-service actions
    const auditUserId = this.$locals?.auditUserId || this._id;
    await userService.updateByIdOrThrow(
        this._id,
        {
            $set: updateUserActivationRequest,
            $unset: {
                ...(
                    unsetLockedOut ? {
                        "requests.activation.lockedUntil": "",
                    } : {}
                )
            }
        },
        { session, logger, languageCode, auditUserId: auditUserId.toString() }
    );

}

UserSchema.methods.isMfaEnabled = function (){
    return this.mfaStatus === "active";
}

UserSchema.methods.verifyMfa = async function (companyId: ObjectId, mfaCode: string, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE): Promise<void> {
    if( !this.isMfaEnabled() ){
        throw apiValidationException("mfa_not_enabled", null, null, languageCode);
    }
    const isValid = speakeasy.totp.verify({
        secret: this.mfaSecret, // The user's stored secret
        token: mfaCode,         // The OTP entered by the user
        window: 1,              // Validate against previous and next OTPs to account for clock drift
    });
    if (!isValid) {
        await this.updateUnsuccessfulLogins(companyId);
        throw apiValidationException("mfa_code_invalid", null, null, languageCode);
    }
}

UserSchema.methods.verifyRequestMfa = function (mfaCode: string): boolean {
    return speakeasy.totp.verify({
        secret: this.requests.mfaActivation.secret, // The user's stored secret
        token: mfaCode,                             // The OTP entered by the user
        window: 1,                                  // Validate against previous and next OTPs to account for clock drift
    });
}

UserSchema.methods.createOrUpdateSession = async function (companyId: ObjectId, deviceId: string, userAgent: string, ipAddress: string, response: Response, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE): Promise<{ session: IUserSession; isNewDevice: boolean }> {

    const { userSessionService } = await getServices();

    const normalizedDeviceId = (typeof deviceId === "string" ? deviceId.trim() : "") || "";

    const now = new Date();
    let userSession = await userSessionService.findOne({
        user: this._id,
        deviceId: normalizedDeviceId,
        company: companyId,
        isActive: true,
    });
    const expiresAt = new Date(now.getTime() + AUTHENTICATION.SESSION_EXPIRES_IN);
    let sessionId: string;
    let isNewDevice = false;

    let geolocation: any = null;
    try {
        if( IP_INFO.ENABLED ){
            const response = await axios.get(`https://ipinfo.io/${ipAddress}/json?token=${IP_INFO.TOKEN}`);
            geolocation = {
                ...response.data,
                time: now
            };
        }
    } catch (error) {}

    if( userSession ){
        // Update existing session
        userSession.lastActiveAt = now;
        userSession.expiresAt = expiresAt;
        if( userSession.geolocation && geolocation ){
            userSession.geolocation.push(geolocation);
        }
        await userSession.save();
        sessionId = userSession.sessionId;
    }
    else{
        // "New device" for security alerts = this deviceId has never been stored for (user, company),
        // not merely "we opened a new session row" (e.g. after revoke/inactive).
        const anyPriorSameDevice = await userSessionService.findOne({
            user: this._id,
            deviceId: normalizedDeviceId,
            company: companyId,
        });
        isNewDevice = !anyPriorSameDevice;

        sessionId = randomUUID();
        userSession = await userSessionService.create({
            user: this._id,
            company: companyId,
            sessionId,
            deviceId: normalizedDeviceId,
            userAgent,
            ipAddress,
            geolocation: !!geolocation ? [geolocation]: [],
            createdAt: now,
            lastActiveAt: now,
            expiresAt,
            isActive: true,
        });
    }

    if (response) {
        response.cookie("sessionId", sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: AUTHENTICATION.SESSION_EXPIRES_IN,
        });
    }

    return { session: userSession, isNewDevice };

}

UserSchema.methods.generateJWTToken = async function (companyId: ObjectId, audience: "client" | "panel", userSessionId: string, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE): Promise<{token: string, refreshToken: string}> {
    try{

        const { companyService } = await getServices();
        const company = await companyService.findByIdOrThrow(companyId, {languageCode}, "", "_id name");

        const token = jwt.sign(
            {
                id: this._id.toString(),
                sessionId: userSessionId,
                company: {
                    _id: company._id.toString(),
                    name: company.name
                },
                username: this.username
            },
            AUTHENTICATION.JWT_SECRET,
            {
                issuer: AUTHENTICATION.JWT_ISSUER,
                audience: audience === "client" ? AUTHENTICATION.JWT_CLIENT_AUDIENCE : AUTHENTICATION.JWT_PANEL_AUDIENCE,
                expiresIn: AUTHENTICATION.JWT_EXPIRES_IN
            }
        );

        // Generate refresh token (long-lived, minimal payload for security)
        const refreshToken = jwt.sign(
            {
                id: this._id.toString(),
                sessionId: userSessionId,
                companyId: companyId.toString(),
                type: "refresh"
            },
            AUTHENTICATION.JWT_SECRET,
            {
                issuer: AUTHENTICATION.JWT_ISSUER,
                audience: audience === "client" ? AUTHENTICATION.JWT_CLIENT_AUDIENCE : AUTHENTICATION.JWT_PANEL_AUDIENCE,
                expiresIn: AUTHENTICATION.JWT_REFRESH_TOKEN_EXPIRES_IN
            }
        );

        return {
            token,
            refreshToken
        };
    }
    catch(e: any){
        throw apiValidationException("could_not_sign_JWT", null, null, languageCode);
    }
}

UserSchema.methods.sendDisableMfaEmail = async function (languageCode: string = CONSTANTS.DEFAULT_LANGUAGE, session?: ClientSession, logger?: serverLogger){

    // Check if MFA is enabled
    if (!this.isMfaEnabled()) {
        throw apiValidationException("mfa_not_enabled_to_receive_deactivation_code", null, null, languageCode);
    }

    const now = new Date();

    const deactivationCode = generateRandomString(64);
    let updateMfaDeactivationRequest = {
        "requests.mfaDeactivation.code": deactivationCode
    }

    let unsetLockedOut = false;
    if( !!this.requests?.mfaDeactivation?.lockedUntil && new Date(this.requests.mfaDeactivation.lockedUntil).getTime() > now.getTime() ){
        throw apiValidationException(
            "mfa_deactivation_link_sent_too_many_times",
            null,
            null,
            languageCode,
            [
                this.requests.mfaDeactivation.lockedUntil.toLocaleString(languageCode, {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: this.timezone
                })
            ]
        );
    }
    else {

        if( !!this.requests?.mfaDeactivation?.lockedUntil ){
            unsetLockedOut = true;
            updateMfaDeactivationRequest["requests.mfaDeactivation.attempts"] = 1;
        }
        else{
            if ( !!this.requests?.mfaDeactivation?.attempts && AUTHENTICATION.ACTIVATE_MFA_TIMEOUT && this.requests.mfaDeactivation.attempts >= (AUTHENTICATION.MFA_DISABLE_MAX_ATTEMPTS - 1)) {
                updateMfaDeactivationRequest["requests.mfaDeactivation.lockedUntil"] = new Date(now.getTime() + AUTHENTICATION.MFA_DISABLE_LOCKOUT_DURATION);
                updateMfaDeactivationRequest["requests.mfaDeactivation.attempts"] = (this.requests.mfaDeactivation.attempts ?? 0) + 1;
            }
            else{
                updateMfaDeactivationRequest["requests.mfaDeactivation.attempts"] = (this.requests?.mfaDeactivation?.attempts ?? 0) + 1;
            }
        }
    }

    const mfaCompanyId =
        this.roles?.[0]?.company?._id?.toString() ??
        this.roles?.[0]?.company?.toString();

    const mfaDisableEmail: MFADisableEmailEvent = {
        eventType: "mfa_disable_email",
        email: this.username,
        userId: this._id.toString(),
        resetCode: deactivationCode,
        fullName: this.name + " " + this.surname,
        languageCode: languageCode,
        timestamp: Date.now(),
        companyId: mfaCompanyId,
    }

    if (isKafkaConnected()) {
        publishMfaDisableEmailEvent(mfaDisableEmail).catch((err) => {console.error(`Failed to publish mfa disable email to Kafka: ${err.message}`);});
    }
    else {
        await SendMfaDisableEmail(mfaDisableEmail, session);
    }

    const { userService } = await getServices();
    // Use auditUserId from $locals if set (for public endpoints, this will be the user's own ID for self-action)
    // Otherwise, use the user's own ID as fallback for self-service actions
    const auditUserId = this.$locals?.auditUserId || this._id;
    await userService.updateByIdOrThrow(
        this._id,
        {
            $set: updateMfaDeactivationRequest,
            $unset: {
                ...(
                    unsetLockedOut ? {
                        "requests.mfaDeactivation.lockedUntil": "",
                    } : {}
                )
            }
        },
        { session, logger, auditUserId: auditUserId.toString() }
    );

}

UserSchema.methods.sendForgotPasswordEmail = async function (languageCode: string = CONSTANTS.DEFAULT_LANGUAGE, session?: ClientSession, logger?: serverLogger){

    const now = new Date();

    const resetCode = generateRandomString(64);
    let updateForgotPasswordRequest = {
        "requests.passwordReset.code": resetCode
    }

    let unsetLockedOut = false;
    if( this.requests?.passwordReset?.lockedUntil && new Date(this.requests.passwordReset.lockedUntil).getTime() > now.getTime() ){
        throw apiValidationException(
            "reset_password_link_sent_too_many_times",
            null,
            null,
            languageCode,
            [
                this.requests.passwordReset.lockedUntil.toLocaleString(languageCode, {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: this.timezone
                })
            ]
        );
    }
    else {
        if( !!this.requests?.passwordReset?.lockedUntil ){
            unsetLockedOut = true;
            updateForgotPasswordRequest["requests.passwordReset.attempts"] = 1;
        }
        else{
            if (this.requests?.passwordReset?.attempts && AUTHENTICATION.ACTIVATE_PASSWORD_RESET_TIMEOUT && this.requests.passwordReset.attempts >= (AUTHENTICATION.PASSWORD_RESET_MAX_ATTEMPTS - 1)) {
                updateForgotPasswordRequest["requests.passwordReset.lockedUntil"] = new Date(now.getTime() + AUTHENTICATION.PASSWORD_RESET_LOCKOUT_DURATION);
                updateForgotPasswordRequest["requests.passwordReset.attempts"] = (this.requests?.passwordReset?.attempts ?? 0) + 1;
            }
            else{
                updateForgotPasswordRequest["requests.passwordReset.attempts"] = (this.requests?.passwordReset?.attempts ?? 0) + 1;
            }
        }
        updateForgotPasswordRequest["requests.passwordReset.opened"] = false;
    }

    const forgotPasswordCompanyId =
        this.roles?.[0]?.company?._id?.toString() ??
        this.roles?.[0]?.company?.toString();

    let forgotPasswordEmail: ForgotPasswordEmailEvent = {
        eventType: "forgot_password_email",
        email: this.username,
        userId: this._id.toString(),
        resetCode: resetCode,
        fullName: this.name + " " + this.surname,
        expiresAfterOpening: AUTHENTICATION.PASSWORD_RESET_EXPIRE_AFTER_OPEN,
        languageCode: languageCode,
        timestamp: Date.now(),
        companyId: forgotPasswordCompanyId,
    }

    if (isKafkaConnected()) {
        publishForgotPasswordEmailEvent(forgotPasswordEmail).catch((err) => {console.error(`Failed to publish forgot password email to Kafka: ${err.message}`);});
    }
    else {
        await SendForgotPasswordEmail(forgotPasswordEmail, session);
    }

    const { userService } = await getServices();
    // Use auditUserId from $locals if set (for public endpoints, this will be the user's own ID for self-action)
    // Otherwise, use the user's own ID as fallback for self-service actions
    const auditUserId = this.$locals?.auditUserId || this._id;
    await userService.updateByIdOrThrow(
        this._id,
        {
            $set: updateForgotPasswordRequest,
            $unset: {
                ...(
                    unsetLockedOut ? {
                        "requests.passwordReset.lockedUntil": "",
                    } : {}
                )
            }
        },
        { session, logger, languageCode, auditUserId: auditUserId.toString() }
    );

}

UserSchema.methods.sendInvitationEmail = async function (welcomeMessage: string, companyName: string, inviterName: string, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE, companyId: ObjectId, session?: ClientSession, logger?: serverLogger){

    const now = new Date();

    const invitationCode = generateRandomString(64);
    const invitationExpiresAt = new Date();
    invitationExpiresAt.setDate(invitationExpiresAt.getDate() + 7); // Expires in 7 days

    let updateInvitationRequest = {
        "requests.invitation.code": invitationCode,
        "requests.invitation.invitationExpiresAt": invitationExpiresAt,
    }

    let unsetLockedOut = false;
    if (this.requests?.invitation?.lockedUntil && new Date(this.requests.invitation.lockedUntil).getTime() > now.getTime()) {
        throw apiValidationException(
            "invitation_link_sent_too_many_times",
            null,
            null,
            languageCode,
            [
                this.requests.invitation.lockedUntil.toLocaleString(languageCode, {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: this.timezone
                })
            ]
        );
    }
    else {
        if( this.requests?.invitation?.lockedUntil ){
            unsetLockedOut = true;
            updateInvitationRequest["requests.invitation.attempts"] = 1;
        }
        else{
            if (AUTHENTICATION.ACTIVATE_INVITATION_TIMEOUT && (this.requests?.invitation?.attempts ?? 0) >= (AUTHENTICATION.INVITATION_MAX_ATTEMPTS - 1)) {
                updateInvitationRequest["requests.invitation.lockedUntil"] = new Date(now.getTime() + AUTHENTICATION.INVITATION_LOCKOUT_DURATION);
                updateInvitationRequest["requests.invitation.attempts"] = (this.requests?.invitation?.attempts ?? 0) + 1;
            }
            else{
                unsetLockedOut = true;
                updateInvitationRequest["requests.invitation.attempts"] = (this.requests?.invitation?.attempts ?? 0) + 1;
            }
        }
        updateInvitationRequest["requests.invitation.opened"] = false;
    }

    const invitationEmail: InvitationEmailEvent = {
        eventType: "invitation_email",
        email: this.username,
        userId: this._id.toString(),
        fullName: this.name + " " + this.surname,
        welcomeMessage: welcomeMessage,
        invitationCode: invitationCode,
        inviterName: inviterName,
        companyName: companyName,
        languageCode: languageCode,
        timestamp: Date.now(),
        companyId: companyId.toString(),
    }

    if (isKafkaConnected()) {
        publishInvitationEmailEvent(invitationEmail).catch((err) => {console.error(`Failed to publish invitation email to Kafka: ${err.message}`);});
    }
    else {
        await SendInvitationEmail(invitationEmail, session);
    }

    const { userService } = await getServices();
    await userService.updateByIdOrThrow(
        this._id,
        {
            $set: updateInvitationRequest,
            $unset: {
                ...(
                    unsetLockedOut ? {
                        "requests.invitation.lockedUntil": "",
                    } : {}
                )
            }
        },
        {
            session,
            logger,
            languageCode
        });

}

UserSchema.methods.checkPassword =  async function (companyId: ObjectId, candidatePassword: string, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE): Promise<void>{
    if( !(await bcrypt.compare(candidatePassword, this.password)) ){
        await this.updateUnsuccessfulLogins(companyId);
        throw apiValidationException("invalid_credentials", null, null, languageCode);
    }
}

UserSchema.methods.checkAccountAccessibility = async function (companyId: ObjectId, languageCode: string = CONSTANTS.DEFAULT_LANGUAGE, session?: ClientSession, logger?: serverLogger){

    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole) {
        throw apiValidationException("company_role_not_found", null, null, languageCode);
    }
    // if the user is locked out due to many unsuccessful login attempts
    if (companyRole.lockedOutUntil && companyRole.lockedOutUntil > new Date()) {
        throw apiValidationException(
            "user_locked_out",
            null,
            null,
            languageCode,
            [
                companyRole.lockedOutUntil.toLocaleString(languageCode, {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: this.timezone
                })
            ]
        );
    }
    // if admin deactivates the user account
    if( companyRole.active !== "active" ) {
        throw apiValidationException("user_not_active", null, null, languageCode);
    }

    // if the account is not active, it may be that it has not been activated (activation link not opened)
    if( !this.isEmailVerified){
        // Send activation email
        await this.sendActivationEmail(this.username, languageCode, session, logger);
        throw apiValidationException("activation_link_not_opened", null, null, languageCode);
    }
}

UserSchema.methods.updateUnsuccessfulLogins = async function (companyId: ObjectId, session?: ClientSession){
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole) {
        throw apiValidationException("company_role_not_found", null, null, CONSTANTS.DEFAULT_LANGUAGE);
    }

    companyRole.unsuccessfulLogins = (companyRole.unsuccessfulLogins || 0) + 1;
    if (companyRole.unsuccessfulLogins >= AUTHENTICATION.LOGIN_MAX_ATTEMPTS) {
        if( AUTHENTICATION.ACTIVATE_LOGIN_LOCKOUT ){
            companyRole.lockedOutUntil = new Date(Date.now() + AUTHENTICATION.LOGIN_LOCKOUT_DURATION);
        }
        else{
            companyRole.active = "inactive";
        }
    }
    await this.save({session});
}

UserSchema.methods.resetUnsuccessfulLogins = async function (companyId: ObjectId, session?: ClientSession){
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole) {
        throw apiValidationException("company_role_not_found", null, null, CONSTANTS.DEFAULT_LANGUAGE);
    }
    companyRole.unsuccessfulLogins = 0;
    // Ensure auditUserId is set in $locals (should be set by caller for public endpoints)
    // If not set, use user's own ID as fallback for self-service actions
    if (!this.$locals) {
        this.$locals = {};
    }
    if (!this.$locals.auditUserId) {
        this.$locals.auditUserId = this._id;
    }
    await this.save({session});
}

UserSchema.methods.getUnsuccessfulLogins = async function (companyId: ObjectId): Promise<number>{
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole) {
        return 0;
    }
    return companyRole.unsuccessfulLogins || 0;
}

UserSchema.methods.isUserActive = async function (companyId: ObjectId): Promise<boolean>{
    const companyRole = findCompanyRole(this.roles, companyId);
    return companyRole?.active === "active";
}

UserSchema.methods.changeAccountStatus = async function (companyId: ObjectId, status: boolean, session?: ClientSession){
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole) {
        throw apiValidationException("company_role_not_found", null, null, CONSTANTS.DEFAULT_LANGUAGE);
    }
    companyRole.active = status ? "active" : "inactive";
    await this.save({session});
}

UserSchema.methods.getCompanyRolePermissions = async function (companyId: ObjectId): Promise<string[]> {
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole?.roles?.length) {
        return [];
    }
    const roleIds = companyRole?.roles.map((role) => role._id);
    if (!roleIds.length) {
        return [];
    }

    const { roleService } = await getServices();
    const userRoles = await roleService.find({_id: {$in: roleIds}}, {}, {path: "permissions", select: "tag"});

    const permissionSet = new Set<string>();
    for (const role of userRoles) {
        const rolePermissions = (role.permissions).map((permission) => permission.tag);
        rolePermissions.forEach(perm => permissionSet.add(perm));
    }

    return Array.from(permissionSet);
}

UserSchema.methods.companyRoleHasPermission = async function(companyId: ObjectId, permission: string): Promise<boolean> {
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole?.roles?.length) {
        return false;
    }
    const roleIds = companyRole.roles.map((role) => role._id);
    if (!roleIds.length) {
        return false;
    }

    const { roleService } = await getServices();
    const userRoles = await roleService.find({_id: {$in: roleIds}}, {}, {path: "permissions", select: "tag"});

    // Check for permission with early exit
    for (const role of userRoles) {
        const rolePermissions = role.permissions.map((permission) => permission.tag);
        if (rolePermissions.includes(permission)) {
            return true;
        }
    }

    return false;
}

UserSchema.methods.hasAtLeastOneRole = async function (companyId: ObjectId){
    return this.roles?.some((role: IEmbeddedCompanyRole) => role.company?._id.equals(companyId)) ?? false;
}

UserSchema.methods.getUserRoles = async function (companyId: ObjectId): Promise<IRole[]> {
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole?.roles?.length) {
        return [];
    }
    const roleIds = companyRole.roles.map((role) => role._id);
    if (!roleIds.length) {
        return [];
    }

    const { roleService } = await getServices();
    return await roleService.find({_id: {$in: roleIds}}, {});
};

UserSchema.methods.getCompanies = async function (): Promise<{_id: ObjectId, name: string}[]>{
    // Only populate if not already populated
    if (!this.companies || this.companies.length === 0 || typeof this.companies[0] === 'object' && !this.companies[0].name) {
        await this.populate({
            path: "companies",
            select: "_id name",
        });
    }

    // Direct mapping without unnecessary iteration
    return (this.companies as any[]).map(company => ({
        _id: company._id,
        name: company.name
    }));
}

UserSchema.methods.getCompanyIds = async function (): Promise<ObjectId[]>{
    return this.companies?.map((company: ICompany) => company._id) ?? [];
}

UserSchema.methods.isAdmin = async function (companyId: ObjectId): Promise<boolean>{
    const companyRole = findCompanyRole(this.roles, companyId);
    if (!companyRole?.roles?.length) {
        return false;
    }
    const roleIds = companyRole.roles.map((role) => role._id);
    if (!roleIds.length) {
        return false;
    }

    const { roleService } = await getServices();
    const userRoles = await roleService.find({_id: {$in: roleIds}, isAdmin: true}, {});
    return userRoles.length > 0;
}

UserSchema.methods.getTransactionAmounts = async function (companyId: ObjectId, userId: ObjectId, transactionType: TransactionType, startDate: Date = firstOfMonth(), endDate: Date = lastOfMonth() ):Promise<{[key: string]: number}>{
    let returnThis: {[key: string]: number} = {};
    let result = await Transaction.aggregate([
        {
            // Filter by date range and transaction type
            $match: {
                date: {
                    $gte: startDate,
                    $lte: endDate
                },
                type: transactionType,  // Replace with your transaction type
                company: companyId,
                sender: userId,
            }
        },
        {
            // Group by currency and sum the amount
            $group: {
                _id: "$currency",  // Group by currency
                totalAmount: { $sum: "$amount" }  // Sum the amounts
            }
        }
    ]);
    for( let res of result ){
        returnThis[res._id.toString()] = res.totalAmount;
    }
    return returnThis;
}

// ownershipPlugin(UserSchema, true, false );
auditPlugin(UserSchema);
applyUserIndexes(UserSchema);
const User = model<IUser>("User", UserSchema);
normalizeSchemaPermissions(User);
export default User;

addModelData(User)
