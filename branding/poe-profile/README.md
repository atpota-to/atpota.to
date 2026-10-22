# Poe's profile pictures

The library Poe's Bluesky avatar and banner are picked from. The pictures are cut from Poe's hill on the home page and live in `website/public/poe-profile/` so the site serves them (`atpota.to/poe-profile/…`), with a `manifest.json` that lists every one with its tags. The two contact sheets here are for looking the library over and don't ship with the site.

- `sheet-avatars.png`: every avatar, in the circle Bluesky crops to
- `sheet-banners.png`: every banner

## What's in it

**Avatars** (1000×1000 JPEG): Poe large in the middle, with no visitors or falling leaves, so Poe reads at feed size.

- 4 times of day (dawn, day, golden hour, night) × 4 seasons × 6 faces (normal, kawaii, happy, wink, wow, sleepy)
- Halloween nights: sleepy, scawy, wow, kawaii
- New Year's Eve nights: sleepy, wow, happy, wink

**Banners** (1500×500 JPEG): Poe in the middle, so the avatar in the bottom-left corner never covers Poe.

- 4 times of day × 4 seasons × 3 weathers (calm, gusty, and wet: rain, or snow in winter)
- dispatch day (the winged letters) for each time of day and season
- Halloween (two takes), New Year's Eve (two takes), the moon, the beach (two takes), and a cloud at dawn, by day and at golden hour

## Rendering

```sh
cd website
npm run poe-profile                 # everything, then the contact sheets
npm run poe-profile -- avatars      # only the avatars (or banners)
npm run poe-profile -- night-winter # only files whose name contains this
npm run poe-profile -- --sheets     # only the contact sheets
```

The script is `website/scripts/poe-profile.ts`. It needs a Chromium for Playwright, the same one `npm run og` uses, and `CHROMIUM_PATH` points it at another binary.

## How it's used

`mentions/src/profile-look.js`, on the droplet, changes Poe's profile with the sky over New York. It cuts each day in four at sunrise and sunset: dawn from 30 minutes before sunrise, day from 90 minutes after it, golden hour from 90 minutes before sunset, and night from 30 minutes after it. Each slot gets one look the first time the job sees it, from a roll seeded on the slot, so a restart picks the same look:

- **Avatar:** today's season and the time of day. The face is usually the time of day's own and sometimes another, sleepy on about 7 nights in 10. While Poe naps, the face is always sleepy.
- **Banner:** the same time of day, with today's season and the weather station's weather. It switches to dispatch day for a day after an announcement, to Halloween week's nights or New Year's Eve, or now and then to an away day (the moon, the beach, a cloud).

Only the avatar and banner change; the name, bio and pinned post stay as they are. If someone changes the avatar or banner by hand, the profile is left alone for the rest of that day.

`PROFILE_LOOK=dry-run` (the default) works each look out and logs it without writing anything. Read the log with `npm run profile-look` on the droplet, then set `PROFILE_LOOK=on` to go live. The kill switch stops every write.
