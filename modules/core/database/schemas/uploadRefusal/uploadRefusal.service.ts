import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import UploadRefusal, {IUploadRefusal} from "@coreModule/database/schemas/uploadRefusal/uploadRefusal";

class UploadRefusalService extends BaseCrudService<IUploadRefusal, typeof UploadRefusal> {
    constructor() {
        super(UploadRefusal, "UploadRefusal");
    }

    /** One page of every company's refusals, newest first. Raw: the platform's review reads across companies. */
    async findPage(skip: number, limit: number): Promise<IUploadRefusal[]> {
        return this.model.collection.find<IUploadRefusal>({deletedAt: null}).sort({createdAt: -1, _id: -1}).skip(skip).limit(limit).toArray();
    }

    async countAll(): Promise<number> {
        return this.model.collection.countDocuments({deletedAt: null});
    }
}

export const uploadRefusalService = new UploadRefusalService();
