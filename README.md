# astro-emdash

This repo powers the public `afterword.blog` site and its EmDash CMS. It is the main frontend and editing surface for the site.

## Current role

- Serves the public site at `afterword.blog`
- Hosts the EmDash admin and content editing interface
- Stores local site content in D1 and media in R2
- Reads from a mix of sources including the PDS, EmDash content, and a few external feeds

## Architecture

- Public site and CMS: this repo
- Background sync worker: the SvelteKit repo on `sync.afterword.blog`

The SvelteKit worker still handles a few backend-style sync jobs, especially:

- Swarm/Foursquare push -> PDS check-ins
- music import -> PDS and related snapshots

If we ever need to review that side of the architecture, start with [`docs/architecture-notes.md`](./docs/architecture-notes.md).

## Notes

- This repo started from an EmDash Cloudflare template, but it is now a customized site
- Some older public routes and sync logic were intentionally removed once `afterword.blog` moved here from the older SvelteKit site
