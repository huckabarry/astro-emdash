interface Page {
	[key: string]: unknown;
	html?: string;
}

interface Post {
	[key: string]: unknown;
	html?: string;
	source_path?: string;
	source_type?: string;
	source_published_at?: string | null;
}
