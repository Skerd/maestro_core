import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import BlogCategory, {type IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";

export class BlogCategoryService extends BaseCrudService<IBlogCategory, typeof BlogCategory> {
    constructor() {
        super(BlogCategory, "BlogCategory");
    }
}

export const blogCategoryService = new BlogCategoryService();
