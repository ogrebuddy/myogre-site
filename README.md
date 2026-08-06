# myog.re

The landing site for MyOgre — a personal software suite built around a small
animated character. Live at **[myog.re](https://myog.re)**.

The site itself is deliberately small: two pages, no framework runtime shipped
to the browser, and a handful of vanilla scripts for the animated mascot, the
screenshot gallery, and the subscribe form.

## What it covers

- **Home** — the animated Ogre, with a recorded greeting and viseme lip-sync
  driven by the same animation spec the other apps use.
- **Projects** — case studies for the Ogrebuddy ecosystem, Ogredex, and
  MyOgre + Ogrebrain, plus a timeline of how the suite grew.

## Stack

- [Astro](https://astro.build) — static output, zero JS by default
- Cloudflare Pages for hosting, with a Pages Function for the subscribe endpoint
- Plain CSS with custom properties; a light "bodega" theme and a neon dark theme

## Running locally

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # static output to ./dist
npm run preview  # serve the build
```

Requires Node 22.12 or newer.

## Subscribe endpoint

`functions/api/subscribe.js` emails new addresses via
[Resend](https://resend.com). Set these in the Cloudflare Pages environment:

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Resend API key |
| `SUBSCRIBE_TO` | yes | Address that receives the notification |
| `SUBSCRIBE_FROM` | no | Verified sender; defaults to Resend's shared onboarding address |

With the variables unset the endpoint still accepts submissions and simply does
nothing, so local development never shows a visitor an error.

## Layout

```
functions/api/   Cloudflare Pages Functions
public/          images, fonts, audio, animation spec
src/components/  Ogre hero, cards, case studies, lightbox
src/data/        case study and timeline content
src/layouts/     shared page shell
src/pages/       routes
src/styles/      global theme and custom properties
```

Content lives in `src/data/projects.ts` — adding a project or a milestone means
editing an array, not copying markup.
