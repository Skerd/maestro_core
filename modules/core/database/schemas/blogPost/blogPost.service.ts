import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import BlogPost, {type IBlogPost} from "@coreModule/database/schemas/blogPost/blogPost";

export class BlogPostService extends BaseCrudService<IBlogPost, typeof BlogPost> {
    constructor() {
        super(BlogPost, "BlogPost");
    }
}

export const blogPostService = new BlogPostService();
