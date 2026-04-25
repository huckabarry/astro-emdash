import { env } from "cloudflare:workers";
import { fetchWithTimeout } from "./network";

const ALBUMWHALE_LIST_URL = "https://albumwhale.com/bryan/listening-now";
const ALBUMWHALE_FEED_URL = "https://albumwhale.com/bryan/listening-now.atom";
const CRUCIAL_TRACKS_FEED_URL =
  "https://www.crucialtracks.org/profile/bryan/feed.json";
const MEDIA_API_BASE_URL = "https://sync.afterword.blog";
const POPFEED_ITEM_COLLECTION = "social.popfeed.feed.listItem";
const POPFEED_LIST_COLLECTION = "social.popfeed.feed.list";
const MEDIA_CACHE_TTL_MS = 1000 * 60 * 10;
const MEDIA_TIMELINE_PAGE_CACHE_TTL_MS = 1000 * 60;
const DEFAULT_REPO = "did:plc:vt4k6d3e5rjw65cuzaf3nufq";
const MEDIA_FETCH_TIMEOUT_MS = 2_500;

export type MediaTimelineLink = {
  label: string;
  url: string;
  external: boolean;
};

export type AlbumEntry = {
  id: string;
  slug: string;
  title: string;
  albumTitle: string;
  artist: string;
  note: string;
  noteHtml?: string | null;
  excerpt: string;
  coverImage: string | null;
  publishedAt: Date;
  displayDate: string;
  sourceUrl: string;
  localPath: string;
  listenLinks: { label: string; url: string }[];
};

export type TrackEntry = {
  id: string;
  slug: string;
  title: string;
  trackTitle: string;
  artist: string;
  note: string;
  noteHtml?: string | null;
  excerpt: string;
  artworkUrl: string | null;
  publishedAt: Date;
  displayDate: string;
  sourceUrl: string;
  localPath: string;
  appleMusicUrl: string | null;
  playlistUrl: string | null;
  songlinkUrl: string | null;
  previewUrl: string | null;
  listenLinks: { label: string; url: string }[];
};

export type PopfeedItemType = "book" | "movie" | "tv_show";

export type PopfeedItem = {
  id: string;
  uri: string;
  cid: string;
  slug: string;
  type: PopfeedItemType;
  section: "books" | "movies" | "shows";
  sectionLabel: "Books" | "Movies" | "Shows";
  localPath: string;
  title: string;
  mainCredit: string;
  mainCreditRole: string;
  genres: string[];
  listUri: string;
  listName: string;
  listDescription: string;
  listType: string;
  listTypeLabel: string;
  activityLabel: string;
  activityDateLabel: string;
  addedAt: Date | null;
  activityAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  releaseDate: Date | null;
  date: Date;
  displayDate: string;
  activityDisplayDate: string | null;
  posterImage: string | null;
  sourcePosterImage: string | null;
  backdropUrl: string | null;
  identifiers: Record<string, string>;
  links: { label: string; url: string }[];
};

export type MediaTimelineItem = {
  id: string;
  kind: "track" | "album" | "popfeed";
  label: string;
  title: string;
  href: string;
  dateIso: string;
  dateLabel: string;
  summary: string;
  imageUrl: string | null;
  imageAlt: string | null;
  tags: string[];
  artist?: string;
  audioUrl?: string | null;
  credit?: string;
  links: MediaTimelineLink[];
  mediaType?: string;
  statusLabel?: string;
  activityLabel?: string;
};

type RuntimeEnv = Record<string, unknown>;
type MediaTimelineFilterKind = MediaTimelineItem["kind"];

type MediaTimelinePageResponse = {
  items: MediaTimelineItem[];
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  generatedAt?: string | null;
  filters?: {
    kinds?: MediaTimelineFilterKind[];
    mediaTypes?: PopfeedItemType[];
  };
};

function getCacheScope() {
  const scope = globalThis as typeof globalThis & {
    __afterwordAstroMediaCache?: {
      expiresAt: number;
      albums: AlbumEntry[];
      tracks: TrackEntry[];
      popfeed: PopfeedItem[];
      timeline: MediaTimelineItem[];
    } | null;
    __afterwordAstroMediaPromise?: Promise<{
      albums: AlbumEntry[];
      tracks: TrackEntry[];
      popfeed: PopfeedItem[];
      timeline: MediaTimelineItem[];
    }> | null;
    __afterwordAstroLatestTrackCache?: {
      expiresAt: number;
      item: MediaTimelineItem | null;
    } | null;
    __afterwordAstroLatestTrackPromise?: Promise<MediaTimelineItem | null> | null;
    __afterwordAstroMediaTimelinePageCache?: Map<
      string,
      { expiresAt: number; page: MediaTimelinePageResponse }
    >;
    __afterwordAstroMediaTimelinePagePromises?: Map<
      string,
      Promise<MediaTimelinePageResponse>
    >;
    __afterwordAlbumWhalePageMap?: Promise<Map<string, string>>;
    __afterwordAlbumWhaleLinkMap?: Promise<
      Map<string, { label: string; url: string }[]>
    >;
    __afterwordAstroDidCache?: Map<string, string>;
    __afterwordAstroPdsCache?: Map<string, string>;
  };

  if (!("__afterwordAstroMediaCache" in scope)) {
    scope.__afterwordAstroMediaCache = null;
    scope.__afterwordAstroMediaPromise = null;
    scope.__afterwordAstroLatestTrackCache = null;
    scope.__afterwordAstroLatestTrackPromise = null;
  }

  if (!scope.__afterwordAstroMediaTimelinePageCache) {
    scope.__afterwordAstroMediaTimelinePageCache = new Map();
  }

  if (!scope.__afterwordAstroMediaTimelinePagePromises) {
    scope.__afterwordAstroMediaTimelinePagePromises = new Map();
  }

  if (!scope.__afterwordAstroDidCache) {
    scope.__afterwordAstroDidCache = new Map();
  }

  if (!scope.__afterwordAstroPdsCache) {
    scope.__afterwordAstroPdsCache = new Map();
  }

  return scope;
}

function normalizeString(value: unknown) {
  return String(value || "").trim();
}

function getMediaTimelineApiBaseUrl(runtimeEnv: RuntimeEnv = env) {
  const configured = normalizeString(
    runtimeEnv.MEDIA_API_URL || runtimeEnv.SYNC_SITE_URL || MEDIA_API_BASE_URL,
  )
    .replace(/\/+$/, "")
    .replace(/\/media\/timeline\.json$/i, "");
  return configured;
}

function buildMediaTimelinePageCacheKey({
  offset,
  limit,
  kind,
  mediaType,
}: {
  offset: number;
  limit: number;
  kind?: MediaTimelineFilterKind | null;
  mediaType?: PopfeedItemType | null;
}) {
  return JSON.stringify({
    offset,
    limit,
    kind: kind || null,
    mediaType: mediaType || null,
  });
}

function decodeHtmlEntities(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value: string) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(value: string, maxLength = 220) {
  const text = stripHtml(value);
  if (!text || text.length <= maxLength) return text;
  return `${text
    .slice(0, maxLength)
    .replace(/\s+\S*$/, "")
    .trim()}…`;
}

function formatDisplayDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function slugify(value: string) {
  return (
    String(value || "")
      .toLowerCase()
      .trim()
      .replace(/['".,!?()[\]{}:;]+/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function absolutizeUrl(value: string, base: string) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  try {
    return new URL(normalized, base).toString();
  } catch {
    return normalized;
  }
}

function splitTitleAndArtist(value: string) {
  const normalized = decodeHtmlEntities(String(value || ""));
  const match = normalized.match(/^["*“”\s]*([^*"]+?)["*“”\s]+by\s+(.+)$/i);
  if (match) {
    return { title: match[1].trim(), artist: match[2].trim() };
  }

  const parts = normalized.split(/\s+by\s+/i);
  if (parts.length >= 2) {
    const artist = parts.pop() || "";
    return { title: parts.join(" by ").trim(), artist: artist.trim() };
  }

  return { title: normalized.trim() || "Untitled", artist: "" };
}

function normalizeTrackKey(title: string, artist: string) {
  return `${slugify(title)}::${slugify(artist)}`;
}

function extractMarkdownLink(body: string, pattern: RegExp) {
  const match = String(body || "").match(
    new RegExp(`\\[([^\\]]+)\\]\\(([^)]+)\\)`, "gi"),
  );
  if (!match) return null;
  const matches = [...String(body || "").matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  const found = matches.find((entry) => pattern.test(entry[1]));
  return found ? found[2] : null;
}

function extractAlbumFeedBody(contentHtml: string) {
  const decoded = decodeHtmlEntities(String(contentHtml || ""));
  const imageMatch = decoded.match(/<img\b[^>]*src="([^"]+)"[^>]*>/i);
  const noteMatches = [...decoded.matchAll(/<p>([\s\S]*?)<\/p>/gi)];
  const noteHtml = noteMatches
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  const note = stripHtml(noteHtml);

  return {
    coverImage: imageMatch?.[1] || null,
    note,
    noteHtml: noteHtml || null,
  };
}

function extractTrackNoteHtmlFromContentHtml(value: string) {
  const noteMatch = String(value || "").match(/<div>([\s\S]*?)<\/div>/i);
  return noteMatch?.[1]?.trim() || null;
}

function createTrackSlugFromPublishedAt(
  date: Date,
  trackTitle: string,
  artist: string,
) {
  const datePrefix = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return `${slugify(datePrefix)}-${slugify(`${trackTitle}-${artist}`)}`;
}

function getAlbumIdFromOriginalUrl(url: string) {
  const fragment = String(url || "").split("#")[1] || "";
  return fragment.startsWith("album_") ? fragment : null;
}

async function getAlbumWhalePageMap() {
  const scope = getCacheScope();
  if (!scope.__afterwordAlbumWhalePageMap) {
    scope.__afterwordAlbumWhalePageMap = (async () => {
      try {
        const response = await fetchWithTimeout(
          ALBUMWHALE_LIST_URL,
          {
            headers: { "User-Agent": "afterword-astro media sync" },
          },
          MEDIA_FETCH_TIMEOUT_MS,
        );
        if (!response.ok) return new Map<string, string>();

        const html = await response.text();
        const items = [
          ...html.matchAll(
            /<li id="(album_\d+)"[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>/gi,
          ),
        ];
        return new Map(
          items.map((match) => [
            match[1],
            new URL(match[2], ALBUMWHALE_LIST_URL).toString(),
          ]),
        );
      } catch {
        return new Map<string, string>();
      }
    })();
  }

  return scope.__afterwordAlbumWhalePageMap;
}

function extractListenLinksFromAlbumPage(pageHtml: string, pageUrl: string) {
  const sectionMatch = String(pageHtml || "").match(
    /<div class="streaming-list">([\s\S]*?)<\/div>\s*<div class="album-lists">/i,
  );

  if (!sectionMatch) return [];

  const seen = new Set<string>();
  const links = [
    ...sectionMatch[1].matchAll(
      /<li>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi,
    ),
  ];

  return links
    .map((match) => ({
      url: new URL(match[1], pageUrl).toString(),
      label: stripHtml(match[2]).replace(/\s+/g, " ").trim(),
    }))
    .filter((link) => link.url && link.label)
    .filter((link) => {
      const key = `${link.label}::${link.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function getAlbumWhaleListenLinks() {
  const scope = getCacheScope();
  if (!scope.__afterwordAlbumWhaleLinkMap) {
    scope.__afterwordAlbumWhaleLinkMap = (async () => {
      const pageMap = await getAlbumWhalePageMap();
      const entries = [...pageMap.entries()];
      const resolved = await Promise.all(
        entries.map(async ([albumId, pageUrl]) => {
          try {
            const response = await fetchWithTimeout(
              pageUrl,
              {
                headers: { "User-Agent": "afterword-astro media sync" },
              },
              MEDIA_FETCH_TIMEOUT_MS,
            );
            if (!response.ok) return [albumId, []] as const;
            const html = await response.text();
            return [
              albumId,
              extractListenLinksFromAlbumPage(html, pageUrl),
            ] as const;
          } catch {
            return [albumId, []] as const;
          }
        }),
      );
      return new Map<string, { label: string; url: string }[]>(resolved);
    })();
  }

  return scope.__afterwordAlbumWhaleLinkMap;
}

async function fetchRemoteAlbums(): Promise<AlbumEntry[]> {
  const listenLinksByAlbumId = await getAlbumWhaleListenLinks();

  try {
    const response = await fetchWithTimeout(
      ALBUMWHALE_FEED_URL,
      {
        headers: { "User-Agent": "afterword-astro media sync" },
      },
      MEDIA_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return [];

    const xml = await response.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];

    return entries
      .map((match) => {
        const entry = match[1] || "";
        const title = decodeHtmlEntities(
          entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "Untitled",
        ).trim();
        const sourceUrl = decodeHtmlEntities(
          entry.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/i)?.[1] ||
            "",
        ).trim();
        const publishedAt = new Date(
          decodeHtmlEntities(
            entry.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ||
              String(Date.now()),
          ),
        );
        const contentHtml =
          entry.match(
            /<content[^>]*type="html"[^>]*>([\s\S]*?)<\/content>/i,
          )?.[1] || "";
        const albumId = getAlbumIdFromOriginalUrl(sourceUrl) || slugify(title);
        const parsed = splitTitleAndArtist(title);
        const body = extractAlbumFeedBody(contentHtml);

        return {
          id: albumId,
          slug: albumId,
          title,
          albumTitle: parsed.title,
          artist: parsed.artist,
          note: body.note,
          noteHtml: body.noteHtml,
          excerpt: body.note,
          coverImage: body.coverImage,
          publishedAt,
          displayDate: formatDisplayDate(publishedAt),
          sourceUrl,
          localPath: `/music/${albumId}`,
          listenLinks: listenLinksByAlbumId.get(albumId) || [],
        } satisfies AlbumEntry;
      })
      .filter(
        (entry) =>
          entry.sourceUrl && !Number.isNaN(entry.publishedAt.getTime()),
      )
      .sort(
        (left, right) =>
          right.publishedAt.getTime() - left.publishedAt.getTime(),
      );
  } catch {
    return [];
  }
}

async function fetchRemoteTracks(): Promise<TrackEntry[]> {
  try {
    const response = await fetchWithTimeout(
      CRUCIAL_TRACKS_FEED_URL,
      {
        headers: { "User-Agent": "afterword-astro media sync" },
      },
      MEDIA_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      items?: Array<{
        url?: string;
        id?: string;
        content_html?: string;
        content_text?: string;
        date_published?: string;
        _song_details?: {
          artist?: string;
          song?: string;
          artwork_url?: string;
          apple_music_url?: string;
          songlink_url?: string;
          preview_url?: string;
          content?: string;
        };
      }>;
    };

    return (data.items || [])
      .map((item) => {
        const sourceUrl = absolutizeUrl(
          item.url || item.id || "",
          CRUCIAL_TRACKS_FEED_URL,
        );
        const trackTitle = normalizeString(item._song_details?.song);
        const artist = normalizeString(item._song_details?.artist);
        const publishedAt = new Date(String(item.date_published || Date.now()));
        const note = stripHtml(
          String(
            item._song_details?.content ||
              item.content_text ||
              item.content_html ||
              "",
          ).trim(),
        );
        const noteHtml = extractTrackNoteHtmlFromContentHtml(
          String(item.content_html || ""),
        );
        const slug = createTrackSlugFromPublishedAt(
          publishedAt,
          trackTitle,
          artist,
        );
        const listenLinks: { label: string; url: string }[] = [];
        if (sourceUrl)
          listenLinks.push({ label: "Crucial Tracks", url: sourceUrl });
        if (item._song_details?.apple_music_url) {
          listenLinks.push({
            label: "Apple Music",
            url: item._song_details.apple_music_url,
          });
        }
        if (item._song_details?.songlink_url) {
          listenLinks.push({
            label: "Listen elsewhere",
            url: item._song_details.songlink_url,
          });
        }

        return {
          id: sourceUrl || slug,
          slug,
          title: `${trackTitle} - ${artist}`,
          trackTitle,
          artist,
          note,
          noteHtml,
          excerpt: note,
          artworkUrl: item._song_details?.artwork_url || null,
          publishedAt,
          displayDate: formatDisplayDate(publishedAt),
          sourceUrl,
          localPath: `/listening/${slug}`,
          appleMusicUrl: item._song_details?.apple_music_url || null,
          playlistUrl: null,
          songlinkUrl: item._song_details?.songlink_url || null,
          previewUrl: item._song_details?.preview_url || null,
          listenLinks,
        } satisfies TrackEntry;
      })
      .filter(
        (item) => item.trackTitle && !Number.isNaN(item.publishedAt.getTime()),
      )
      .sort(
        (left, right) =>
          right.publishedAt.getTime() - left.publishedAt.getTime(),
      );
  } catch {
    return [];
  }
}

async function resolveAtprotoDid(identifier: string) {
  const normalized = normalizeString(identifier);
  if (!normalized) {
    throw new Error("ATProto identifier is not configured.");
  }

  if (normalized.startsWith("did:")) {
    return normalized;
  }

  const scope = getCacheScope();
  const cached = scope.__afterwordAstroDidCache?.get(normalized);
  if (cached) return cached;

  const response = await fetchWithTimeout(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalized)}`,
    {},
    MEDIA_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(
      `Unable to resolve ATProto handle ${normalized}: ${response.status}`,
    );
  }

  const payload = (await response.json()) as { did?: string };
  const did = normalizeString(payload.did);
  if (!did) {
    throw new Error(`ATProto handle ${normalized} did not resolve to a DID.`);
  }

  scope.__afterwordAstroDidCache?.set(normalized, did);
  return did;
}

async function resolveAtprotoService(
  runtimeEnv: RuntimeEnv,
  identifier: string,
) {
  const did = await resolveAtprotoDid(identifier);
  const configured = normalizeString(
    runtimeEnv.STANDARD_SITE_PDS_URL || runtimeEnv.ATPROTO_PDS_URL,
  ).replace(/\/+$/, "");
  if (configured) {
    return { did, serviceUrl: configured };
  }

  const scope = getCacheScope();
  const cached = scope.__afterwordAstroPdsCache?.get(did);
  if (cached) {
    return { did, serviceUrl: cached };
  }

  const response = await fetchWithTimeout(
    `https://plc.directory/${encodeURIComponent(did)}`,
    {},
    MEDIA_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(
      `Unable to resolve DID document for ${did}: ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    service?: Array<{ type?: string; serviceEndpoint?: string }>;
  };
  const serviceUrl =
    payload.service?.find(
      (service) => service.type === "AtprotoPersonalDataServer",
    )?.serviceEndpoint || "";
  if (!serviceUrl) {
    throw new Error(
      `DID document for ${did} did not include a PDS service endpoint.`,
    );
  }

  const normalizedUrl = serviceUrl.replace(/\/+$/, "");
  scope.__afterwordAstroPdsCache?.set(did, normalizedUrl);
  return { did, serviceUrl: normalizedUrl };
}

function getRepo(runtimeEnv: RuntimeEnv) {
  return (
    normalizeString(
      runtimeEnv.ATPROTO_REPO ||
        runtimeEnv.STANDARD_SITE_IDENTIFIER ||
        runtimeEnv.ATPROTO_IDENTIFIER,
    ) || DEFAULT_REPO
  );
}

function getBlobUrl(serviceUrl: string, did: string, cid: string) {
  return `${serviceUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}

function normalizeDate(value: unknown) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function normalizeIdentifiers(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalized = normalizeString(entry);
      return normalized ? [[key, normalized]] : [];
    }),
  );
}

function titleCase(value: string) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function naturalListTypeLabel(value: string) {
  switch (normalizeString(value).toLowerCase()) {
    case "read_books":
      return "Read";
    case "to_read_books":
      return "Want to Read";
    case "currently_reading_books":
      return "Currently Reading";
    case "watched_movies":
    case "watched_tv_shows":
      return "Watched";
    case "movie_watchlist":
      return "Watchlist";
    case "default":
      return "Logged";
    default:
      return titleCase(value);
  }
}

function getActivityMetadata(value: string) {
  switch (normalizeString(value).toLowerCase()) {
    case "read_books":
      return { label: "Finished reading", dateLabel: "Finished" };
    case "currently_reading_books":
      return { label: "Started reading", dateLabel: "Started" };
    case "to_read_books":
      return { label: "Added to reading list", dateLabel: "Added" };
    case "watched_movies":
    case "watched_tv_shows":
      return { label: "Watched", dateLabel: "Watched" };
    case "movie_watchlist":
      return { label: "Added to watchlist", dateLabel: "Added" };
    default: {
      const fallback = naturalListTypeLabel(value);
      return { label: fallback, dateLabel: "Updated" };
    }
  }
}

function getSection(type: PopfeedItemType) {
  switch (type) {
    case "book":
      return { section: "books" as const, sectionLabel: "Books" as const };
    case "tv_show":
      return { section: "shows" as const, sectionLabel: "Shows" as const };
    default:
      return { section: "movies" as const, sectionLabel: "Movies" as const };
  }
}

function getOpenLibraryBookSearchUrl(identifiers: Record<string, string>) {
  const isbn = identifiers.isbn13 || identifiers.isbn10;
  if (isbn) return `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}`;
  const work = identifiers.openLibraryWorkId;
  if (work) return `https://openlibrary.org/works/${encodeURIComponent(work)}`;
  return null;
}

function getPopfeedLinks(
  type: PopfeedItemType,
  identifiers: Record<string, string>,
) {
  const links: { label: string; url: string }[] = [];

  if (type === "book") {
    const openLibraryUrl = getOpenLibraryBookSearchUrl(identifiers);
    if (openLibraryUrl) {
      links.push({ label: "Open Library", url: openLibraryUrl });
    }
    return links;
  }

  if (identifiers.tmdbId) {
    links.push({
      label: "TMDB",
      url: `https://www.themoviedb.org/${type === "tv_show" ? "tv" : "movie"}/${encodeURIComponent(identifiers.tmdbId)}`,
    });
  }

  if (identifiers.imdbId) {
    links.push({
      label: "IMDb",
      url: `https://www.imdb.com/title/${encodeURIComponent(identifiers.imdbId)}/`,
    });
  }

  return links;
}

async function fetchCollectionRecords(
  serviceUrl: string,
  did: string,
  collection: string,
) {
  const records: Array<Record<string, unknown>> = [];
  let cursor = "";

  for (;;) {
    const params = new URLSearchParams({
      repo: did,
      collection,
      limit: "100",
    });

    if (cursor) params.set("cursor", cursor);

    const response = await fetchWithTimeout(
      `${serviceUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`,
      {
        headers: { accept: "application/json" },
      },
      MEDIA_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`${collection} request failed with ${response.status}`);
    }

    const data = (await response.json()) as {
      cursor?: string;
      records?: Array<Record<string, unknown>>;
    };

    records.push(...(data.records || []));
    cursor = normalizeString(data.cursor);
    if (!cursor) return records;
  }
}

function getBlobRefLink(value: unknown) {
  if (
    typeof value === "object" &&
    value &&
    "ref" in value &&
    typeof value.ref === "object" &&
    value.ref &&
    "$link" in value.ref
  ) {
    return normalizeString((value.ref as { $link?: unknown }).$link);
  }

  return "";
}

function normalizeLists(records: Array<Record<string, unknown>>) {
  return new Map(
    records.map((record) => {
      const value = (record.value as Record<string, unknown>) || {};
      return [
        String(record.uri || ""),
        {
          name: normalizeString(value.name),
          description: normalizeString(value.description),
          listType: normalizeString(value.listType),
        },
      ];
    }),
  );
}

function normalizePopfeedItem(
  record: Record<string, unknown>,
  did: string,
  serviceUrl: string,
  listsByUri: Map<
    string,
    { name: string; description: string; listType: string }
  >,
): PopfeedItem | null {
  const value = (record.value as Record<string, unknown>) || {};
  const type = normalizeString(value.creativeWorkType) as PopfeedItemType;
  if (type !== "book" && type !== "movie" && type !== "tv_show") return null;

  const { section, sectionLabel } = getSection(type);
  const id =
    String(record.uri || "")
      .split("/")
      .pop() || "";
  const title = normalizeString(value.title) || "Untitled";
  const mainCredit = normalizeString(value.mainCredit);
  const mainCreditRole = normalizeString(value.mainCreditRole);
  const genres = normalizeStringArray(value.genres);
  const listUri = normalizeString(value.listUri);
  const list = listsByUri.get(listUri);
  const listType = normalizeString(value.listType || list?.listType);
  const listTypeLabel = naturalListTypeLabel(listType);
  const activity = getActivityMetadata(listType);
  const identifiers = normalizeIdentifiers(value.identifiers);
  const addedAt = normalizeDate(value.addedAt);
  const releaseDate = normalizeDate(value.releaseDate);
  const date = addedAt || releaseDate || new Date(0);
  const posterRef = getBlobRefLink(value.poster);
  const slug = `${slugify(title)}-${id}`;
  const posterImage =
    (posterRef ? getBlobUrl(serviceUrl, did, posterRef) : null) ||
    normalizeString(value.posterUrl) ||
    null;

  return {
    id,
    uri: normalizeString(record.uri),
    cid: normalizeString(record.cid),
    slug,
    type,
    section,
    sectionLabel,
    localPath: `/${section}/${slug}`,
    title,
    mainCredit,
    mainCreditRole,
    genres,
    listUri,
    listName: normalizeString(list?.name),
    listDescription: normalizeString(list?.description),
    listType,
    listTypeLabel,
    activityLabel: activity.label,
    activityDateLabel: activity.dateLabel,
    addedAt,
    activityAt: addedAt,
    startedAt: listType === "currently_reading_books" ? addedAt : null,
    completedAt:
      listType === "read_books" ||
      listType === "watched_movies" ||
      listType === "watched_tv_shows"
        ? addedAt
        : null,
    releaseDate,
    date,
    displayDate: formatDisplayDate(date),
    activityDisplayDate: addedAt ? formatDisplayDate(addedAt) : null,
    posterImage,
    sourcePosterImage: posterImage,
    backdropUrl: normalizeString(value.backdropUrl) || null,
    identifiers,
    links: getPopfeedLinks(type, identifiers),
  };
}

async function fetchPopfeedItems(): Promise<PopfeedItem[]> {
  try {
    const runtimeEnv = env as RuntimeEnv;
    const repo = getRepo(runtimeEnv);
    const { did, serviceUrl } = await resolveAtprotoService(runtimeEnv, repo);
    const [listRecords, itemRecords] = await Promise.all([
      fetchCollectionRecords(serviceUrl, did, POPFEED_LIST_COLLECTION),
      fetchCollectionRecords(serviceUrl, did, POPFEED_ITEM_COLLECTION),
    ]);

    const listsByUri = normalizeLists(listRecords);
    return itemRecords
      .map((record) =>
        normalizePopfeedItem(record, did, serviceUrl, listsByUri),
      )
      .filter((item): item is PopfeedItem => Boolean(item))
      .filter((item) => item.listType !== "to_read_books")
      .sort(
        (left, right) =>
          right.date.getTime() - left.date.getTime() ||
          left.title.localeCompare(right.title),
      );
  } catch {
    return [];
  }
}

function toTimelineLinks(
  links: Array<{ label: string; url: string }>,
  limit = 3,
): MediaTimelineLink[] {
  return (links || []).slice(0, limit).map((link) => ({
    label: link.label,
    url: link.url,
    external: true,
  }));
}

function toTrackTimelineItem(track: TrackEntry): MediaTimelineItem {
  return {
    id: `track-${track.slug}`,
    kind: "track",
    label: "Listening",
    title: track.trackTitle,
    href: track.localPath,
    dateIso: track.publishedAt.toISOString(),
    dateLabel: track.displayDate,
    summary: summarize(track.note || track.excerpt || ""),
    imageUrl: track.artworkUrl || null,
    imageAlt: `${track.trackTitle} by ${track.artist}`,
    tags: [],
    artist: track.artist,
    audioUrl: track.previewUrl || null,
    links: toTimelineLinks(track.listenLinks),
  };
}

function toAlbumTimelineItem(album: AlbumEntry): MediaTimelineItem {
  return {
    id: `album-${album.slug}`,
    kind: "album",
    label: "Album Rotation",
    title: album.albumTitle,
    href: album.localPath,
    dateIso: album.publishedAt.toISOString(),
    dateLabel: album.displayDate,
    summary: summarize(album.note || album.excerpt || ""),
    imageUrl: album.coverImage || null,
    imageAlt: `${album.albumTitle} by ${album.artist}`,
    tags: [],
    artist: album.artist,
    links: toTimelineLinks(album.listenLinks),
  };
}

function getPopfeedLabel(item: PopfeedItem) {
  switch (item.type) {
    case "book":
      return "Book";
    case "tv_show":
      return "Show";
    default:
      return "Movie";
  }
}

function toPopfeedTimelineItem(item: PopfeedItem): MediaTimelineItem {
  return {
    id: `popfeed-${item.type}-${item.slug}`,
    kind: "popfeed",
    label: getPopfeedLabel(item),
    title: item.title,
    href: item.localPath,
    dateIso: item.date.toISOString(),
    dateLabel: item.displayDate,
    summary: item.genres.slice(0, 4).join(", "),
    imageUrl: item.posterImage,
    imageAlt: item.mainCredit
      ? `${item.title} by ${item.mainCredit}`
      : item.title,
    tags: item.listTypeLabel ? [item.listTypeLabel] : [],
    credit: item.mainCredit,
    links: toTimelineLinks(item.links),
    mediaType: item.type,
    statusLabel: item.listTypeLabel,
    activityLabel: item.activityLabel,
  };
}

async function fetchRemoteMediaTimelinePage({
  offset = 0,
  limit = 8,
  kind,
  mediaType,
}: {
  offset?: number;
  limit?: number;
  kind?: MediaTimelineFilterKind | null;
  mediaType?: PopfeedItemType | null;
} = {}): Promise<MediaTimelinePageResponse> {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 60));
  const cacheKey = buildMediaTimelinePageCacheKey({
    offset: normalizedOffset,
    limit: normalizedLimit,
    kind,
    mediaType,
  });
  const scope = getCacheScope();
  const cached = scope.__afterwordAstroMediaTimelinePageCache?.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.page;
  }

  const pending =
    scope.__afterwordAstroMediaTimelinePagePromises?.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    const endpoint = new URL(
      `${getMediaTimelineApiBaseUrl()}/media/timeline.json`,
    );
    endpoint.searchParams.set("offset", String(normalizedOffset));
    endpoint.searchParams.set("limit", String(normalizedLimit));
    if (kind) endpoint.searchParams.set("kind", kind);
    if (mediaType) endpoint.searchParams.set("mediaType", mediaType);

    const response = await fetchWithTimeout(
      endpoint,
      {
        headers: {
          accept: "application/json",
        },
      },
      MEDIA_FETCH_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(
        `Unable to fetch remote media timeline: ${response.status}`,
      );
    }

    const payload =
      (await response.json()) as Partial<MediaTimelinePageResponse>;
    const page: MediaTimelinePageResponse = {
      items: Array.isArray(payload.items)
        ? (payload.items as MediaTimelineItem[])
        : [],
      offset: Number.isFinite(payload.offset)
        ? Number(payload.offset)
        : normalizedOffset,
      limit: Number.isFinite(payload.limit)
        ? Number(payload.limit)
        : normalizedLimit,
      total: Number.isFinite(payload.total) ? Number(payload.total) : 0,
      nextOffset:
        payload.nextOffset === null || Number.isFinite(payload.nextOffset)
          ? (payload.nextOffset as number | null)
          : null,
      generatedAt: normalizeString(payload.generatedAt) || null,
      filters: payload.filters,
    };

    scope.__afterwordAstroMediaTimelinePageCache?.set(cacheKey, {
      expiresAt: Date.now() + MEDIA_TIMELINE_PAGE_CACHE_TTL_MS,
      page,
    });

    return page;
  })().finally(() => {
    scope.__afterwordAstroMediaTimelinePagePromises?.delete(cacheKey);
  });

  scope.__afterwordAstroMediaTimelinePagePromises?.set(cacheKey, request);
  return request;
}

async function fetchMediaState() {
  const scope = getCacheScope();
  const cached = scope.__afterwordAstroMediaCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  if (scope.__afterwordAstroMediaPromise) {
    return scope.__afterwordAstroMediaPromise;
  }

  const request = Promise.all([
    fetchRemoteAlbums(),
    fetchRemoteTracks(),
    fetchPopfeedItems(),
  ])
    .then(([albums, tracks, popfeed]) => {
      const timeline = [
        ...tracks.map(toTrackTimelineItem),
        ...albums.map(toAlbumTimelineItem),
        ...popfeed.map(toPopfeedTimelineItem),
      ].sort(
        (left, right) => Date.parse(right.dateIso) - Date.parse(left.dateIso),
      );

      const state = {
        expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
        albums,
        tracks,
        popfeed,
        timeline,
      };

      scope.__afterwordAstroMediaCache = state;
      return state;
    })
    .finally(() => {
      scope.__afterwordAstroMediaPromise = null;
    });

  scope.__afterwordAstroMediaPromise = request;
  try {
    return await request;
  } catch (error) {
    if (cached) {
      console.warn("[media] Falling back to stale cached media state:", error);
      return cached;
    }

    console.warn(
      "[media] Returning empty media state after fetch failure:",
      error,
    );
    return {
      expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
      albums: [],
      tracks: [],
      popfeed: [],
      timeline: [],
    };
  }
}

export async function getAlbums() {
  return (await fetchMediaState()).albums;
}

export async function getAlbumBySlug(slug: string) {
  return (await getAlbums()).find((album) => album.slug === slug) || null;
}

export async function getTracks() {
  return (await fetchMediaState()).tracks;
}

export async function getLatestTrack() {
  const scope = getCacheScope();
  const cached = scope.__afterwordAstroMediaCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.timeline.find((item) => item.kind === "track") || null;
  }

  if (
    scope.__afterwordAstroLatestTrackCache &&
    scope.__afterwordAstroLatestTrackCache.expiresAt > Date.now()
  ) {
    return scope.__afterwordAstroLatestTrackCache.item;
  }

  if (!scope.__afterwordAstroLatestTrackPromise) {
    scope.__afterwordAstroLatestTrackPromise = fetchRemoteMediaTimelinePage({
      offset: 0,
      limit: 1,
      kind: "track",
    })
      .then((page) => {
        const item = page.items[0] || null;
        scope.__afterwordAstroLatestTrackCache = {
          expiresAt: Date.now() + MEDIA_TIMELINE_PAGE_CACHE_TTL_MS,
          item,
        };
        return item;
      })
      .catch(async (error) => {
        console.warn(
          "[media] Falling back to direct latest track fetch:",
          error,
        );
        const tracks = await fetchRemoteTracks();
        const item = tracks[0] ? toTrackTimelineItem(tracks[0]) : null;
        scope.__afterwordAstroLatestTrackCache = {
          expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
          item,
        };
        return item;
      })
      .finally(() => {
        scope.__afterwordAstroLatestTrackPromise = null;
      });
  }

  return scope.__afterwordAstroLatestTrackPromise;
}

export async function getTrackBySlug(slug: string) {
  return (await getTracks()).find((track) => track.slug === slug) || null;
}

export async function getPopfeedItems() {
  return (await fetchMediaState()).popfeed;
}

export async function getPopfeedItemsByType(type: PopfeedItemType) {
  return (await getPopfeedItems()).filter((item) => item.type === type);
}

export async function getPopfeedItemBySlug(
  type: PopfeedItemType,
  slug: string,
) {
  return (
    (await getPopfeedItemsByType(type)).find((item) => item.slug === slug) ||
    null
  );
}

export async function getMediaTimeline(limit = 24) {
  const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 60));

  try {
    return (
      await fetchRemoteMediaTimelinePage({ offset: 0, limit: normalizedLimit })
    ).items;
  } catch (error) {
    console.warn("[media] Falling back to direct timeline assembly:", error);
    return (await fetchMediaState()).timeline.slice(0, normalizedLimit);
  }
}

export async function getMediaTimelinePage(offset = 0, limit = 24) {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 40));

  try {
    const page = await fetchRemoteMediaTimelinePage({
      offset: normalizedOffset,
      limit: normalizedLimit,
    });

    return {
      items: page.items,
      offset: page.offset,
      limit: page.limit,
      total: page.total,
      nextOffset: page.nextOffset,
    };
  } catch (error) {
    console.warn(
      "[media] Falling back to direct timeline page assembly:",
      error,
    );
    const timeline = (await fetchMediaState()).timeline;
    const items = timeline.slice(
      normalizedOffset,
      normalizedOffset + normalizedLimit,
    );
    const nextOffset =
      normalizedOffset + normalizedLimit < timeline.length
        ? normalizedOffset + normalizedLimit
        : null;

    return {
      items,
      offset: normalizedOffset,
      limit: normalizedLimit,
      total: timeline.length,
      nextOffset,
    };
  }
}
