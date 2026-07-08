import mongoose, {Document, Schema, SchemaTypes} from 'mongoose';
import {applyMediaIndexes} from "./media.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";

export interface IMediaMetadata {

    size: number;
    extension: string;
    mime: string;
    safeCheckedFlag: boolean;
    scannedAt?: Date;
    scannerResult?: string;
    resolution?: {
        width: number;
        height: number;
    };
    durationInSeconds?: number;
}

export interface IMedia extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    type: 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'archive' | 'other';
    originalName: string;
    fileName: string;
    filePath: string;
    url?: string;
    fileId?: Schema.Types.ObjectId;
    metadata: IMediaMetadata;
    mimeType: string;
    extension: string;
    fileSize: number;
    sizeInBytes: number;
    resolution?: {
        width: number;
        height: number;
    };
    durationInSeconds?: number;
    createdAt: Date;
    uploadedAt: Date;
}

const MediaSchema = new Schema<IMedia>(
    {
        type: {
            type: String,
            enum: ['image', 'video', 'audio', 'pdf', 'document', 'archive', 'other'],
            required: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        originalName: {
            type: String,
            required: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        fileName: {
            type: String,
            required: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        filePath: {
            type: String,
            required: false,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        url: {
            type: String,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        fileId: {
            type: SchemaTypes.ObjectId,
            required: false,
            index: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        metadata: {
            type: {
                size: {
                    type: Number,
                    required: true,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                extension: {
                    type: String,
                    required: true,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                mime: {
                    type: String,
                    required: true,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                safeCheckedFlag: {
                    type: Boolean,
                    default: false,
                    required: true,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                scannedAt: {
                    type: Date,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                scannerResult: {
                    type: String,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                resolution: {
                    width: {
                        type: Number,
                        permissions: {
                            self: {
                                publicRead: true,
                                write: "no-permission"
                            }
                        }
                    },
                    height: {
                        type: Number,
                        permissions: {
                            self: {
                                publicRead: true,
                                write: "no-permission"
                            }
                        }
                    }
                },
                durationInSeconds: {
                    type: Number,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                }
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        mimeType: {
            type: String,
            required: false,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        extension: {
            type: String,
            required: false,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        fileSize: {
            type: Number,
            required: false,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        sizeInBytes: {
            type: Number,
            required: false,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        resolution: {
            type: {
                width: {
                    type: Number,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                },
                height: {
                    type: Number,
                    permissions: {
                        self: {
                            publicRead: true,
                            write: "no-permission"
                        }
                    }
                }
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        durationInSeconds: {
            type: Number,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        uploadedAt: {
            type: Date,
            default: Date.now,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        createdAt: {
            type: Date,
            default: Date.now,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        }
    },
    {
        accessMode: "loose"
    }
);

MediaSchema.pre('save', function(next) {
    if (this.metadata) {
        if (!this.mimeType) this.mimeType = this.metadata.mime;
        if (!this.extension) this.extension = this.metadata.extension;
        if (!this.fileSize) this.fileSize = this.metadata.size;
        if (!this.sizeInBytes) this.sizeInBytes = this.metadata.size;
        if (this.metadata.resolution && !this.resolution) {
            this.resolution = this.metadata.resolution;
        }
        if (this.metadata.durationInSeconds && !this.durationInSeconds) {
            this.durationInSeconds = this.metadata.durationInSeconds;
        }
    }
    next();
});

ownershipPlugin(MediaSchema);
auditPlugin(MediaSchema);
softDeletePlugin(MediaSchema);
applyMediaIndexes(MediaSchema);
const Media = mongoose.model<IMedia>('Media', MediaSchema);
normalizeSchemaPermissions(Media);
export default Media;