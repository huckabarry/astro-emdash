export type SiteLocale = "en" | "it";

export function normalizeLocale(value: string | undefined | null): SiteLocale {
	return String(value || "").toLowerCase().startsWith("it") ? "it" : "en";
}

export function localizePath(path: string, locale: SiteLocale): string {
	if (locale !== "it") return path;

	const mapped = new Map<string, string>([
		["/", "/it"],
		["/about", "/it/about"],
		["/hello", "/it/hello"],
		["/colophon", "/it/colophon"],
		["/subscribe", "/it/subscribe"],
	]);

	return mapped.get(path) || path;
}

export function navLabel(key: string, locale: SiteLocale): string {
	const labels: Record<SiteLocale, Record<string, string>> = {
		en: {
			home: "Home",
			status: "Status",
			gallery: "Gallery",
			about: "About",
			menu: "Menu",
			hello: "Hello",
			checkins: "Check-ins",
			media: "Media",
			colophon: "Colophon",
			subscribe: "Subscribe",
			morePages: "More pages",
			languageEnglish: "English",
			languageItalian: "Italiano",
		},
		it: {
			home: "Home",
			status: "Stato",
			gallery: "Galleria",
			about: "Chi sono",
			menu: "Menu",
			hello: "Ciao",
			checkins: "Check-in",
			media: "Media",
			colophon: "Colophon",
			subscribe: "Iscriviti",
			morePages: "Altre pagine",
			languageEnglish: "English",
			languageItalian: "Italiano",
		},
	};

	return labels[locale][key] || labels.en[key] || key;
}
