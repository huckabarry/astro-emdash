# Archived Header Search Modal

On April 11, 2026, we removed the magnifying-glass header search UI from the shared site chrome.

What was removed:
- the search button in `/Users/bryanrobb/Git/astro-emdash/src/layouts/Base.astro`
- the modal markup and inline search JS in `/Users/bryanrobb/Git/astro-emdash/src/layouts/Base.astro`
- the modal/button styles in `/Users/bryanrobb/Git/astro-emdash/src/styles/theme.css`

What stayed:
- the dedicated `/search` page
- `/search.json`

So this was only a removal of the second, header-triggered search experience.

If we want it back later, restore the search button, modal, and script from git history around the April 11, 2026 removal, then re-enable the corresponding CSS in `theme.css`.
