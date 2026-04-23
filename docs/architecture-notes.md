# Astro Architecture Notes

This repo is the canonical home of the public `afterword.blog` site and its EmDash CMS.

## What this repo does

- Serves the public site at `afterword.blog`
- Hosts EmDash admin and content editing
- Stores site content in D1
- Stores local media in R2
- Renders pages using Astro on Cloudflare Workers

## What this repo does not currently do

This repo is no longer the main home for external sync pipelines.

Those jobs were split out so the Astro site could stay lean:

- Swarm/Foursquare push and check-in writing live on the SvelteKit worker
- music import and related snapshot refreshes live on the SvelteKit worker

## Current domain split

- `afterword.blog` -> this Astro/EmDash worker
- `sync.afterword.blog` -> SvelteKit sync worker

## Current data shape

The site reads from a mix of sources depending on the feature:

- check-ins: PDS-backed
- status updates: Bluesky / ATProto-backed
- media: mixed; some items come from the PDS and some from external feeds
- pages/posts/sections/forms/media library content: EmDash-managed local content

## Why the split exists

Astro/EmDash is a strong fit for:

- public rendering
- CMS editing
- structured content
- local media and page management

The SvelteKit worker is still a good fit for:

- webhook receivers
- sync bridges
- custom import jobs
- backend-style integration logic

## Related repo

The companion repo lives at:

- `/Users/bryanrobb/Git/afterword-sveltekit-pds`

Start with its resurrection note if we ever want to revisit that side in more detail:

- `/Users/bryanrobb/Git/afterword-sveltekit-pds/docs/resurrection-notes.md`
