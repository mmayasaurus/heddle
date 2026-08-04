Spinventory rebuild — non-negotiable rules for any code you touch.

- **Never pin anything to the screen.** Every screen scrolls as one: headers, footers, legal links
  all live inside the single scroll view. No fixed/absolute/sticky positioning.
- **Data-entry forms are FULL SCREENS** via `FormSheetShell` (menu bar + back arrow + title +
  fields + Save + footer, one `KeyboardAwareScrollView`). Never bottom sheets, never slide-up
  transitions (`slide_from_bottom`/`modal`/`pageSheet`/RN `Modal animationType="slide"` are banned).
- **Semantic tokens only, never hex.** Use `$textPrimary`/`$textSecondary`/`$textMuted` and
  `colors.*` via `useSemanticSurfaceColors()`. The only allowed literal is `#ffffff` on an accent
  fill. Verify every change in BOTH dark and light mode.
- **Every surface is fully opaque** — the knit backdrop never bleeds through UI. Press feedback
  darkens the background; never apply `opacity` to a filled surface.
- **Buttons are rose rounded rectangles** (`getUserMenuButtonColors`, radius 8) — never blue, never
  pills or circles, never the Tamagui `Button`: always `Pressable` + styled `Text`.
- Poppins only; `fontSize` ≤ 18 (`$6`); `fontWeight` ≤ "700".
- Branded assets over generic: `SpinventoryLoadingIndicator` (never `ActivityIndicator`),
  `MISC_ICON_IMAGES`/`NAV_ICON_IMAGES` icons, `ArtworkToggleSwitch`.
- Every SVG needs a same-basename `.png` fallback wired through `resolveArtworkMedia()`.
- Every interactive element carries `accessibilityLabel` + a kebab-case `testID`.
- **Never change user-facing copy** (labels, titles, section headings) — copy changes need Maya's
  explicit approval. Styling passes never change copy, logic, or navigation.
- No `console.log` in committed code. No hardcoded API keys. All async functions handle errors.
- Supabase: **dev project only, never production.**
