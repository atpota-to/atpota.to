# Poe banners

Six 3:1 header images for Poe's and Atpotato's Bluesky profiles. Upload the 1500×500 file (Bluesky's header size; each one is well under the 1MB limit). The `@2x` files are 3000×1000, for anywhere that wants more pixels.

Poe stands in the middle, so the profile avatar in the bottom-left corner never covers Poe.

| File | Scene (`?scene=`) |
| --- | --- |
| `poe-banner-spring-snail.png` | `day,spring,snail-b` |
| `poe-banner-autumn-robin.png` | `golden,autumn,bird-c,robin` |
| `poe-banner-halloween.png` | `night,halloween-c` |
| `poe-banner-moon.png` | `night,moon` |
| `poe-banner-beach.png` | `day,summer,beach-b` |
| `poe-banner-dispatch-day.png` | `day,plain,dispatch-b` |

## Re-rendering

These are screenshots of the home page's scene tile, stretched to 1500×500. Start the site with `cd website && npx vite --port 5199`, then from `website/`:

```sh
X='.home-sun__rays{width:3600px!important;height:3600px!important;margin:-1800px 0 0 -1800px!important}.home-sun[data-scene]{--poe-w:316px!important;--poe-left:-161px!important;--poe-bottom:92px!important}'
node ../branding/banners/render.mjs /tmp/banners "spring|day,spring,snail-b|0|$X"
```

Visitors are rolled at random, so check each render and run it again if an extra visitor turns up.
