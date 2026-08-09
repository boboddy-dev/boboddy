/**
 * Type declarations for Starlight's internal virtual component modules.
 *
 * Starlight ships these in `@astrojs/starlight/virtual-internal.d.ts`, but
 * that file is only referenced for Starlight's own component sources under
 * `node_modules`, which `astro check` doesn't typecheck. Our component
 * overrides (`src/components/Header.astro`, `SiteTitle.astro`) compose
 * Starlight's other default components by importing these same virtual
 * modules — see the "Reuse a built-in component" pattern in Starlight's
 * "Overriding Components" guide — so `astro check` needs its own copy of
 * the relevant declarations to typecheck them.
 *
 * Mirrors the subset of `@astrojs/starlight/virtual-internal.d.ts` this
 * project's overrides actually import.
 */

declare module "virtual:starlight/user-images" {
  type ImageMetadata = import("astro").ImageMetadata;
  export const logos: {
    dark?: ImageMetadata;
    light?: ImageMetadata;
  };
}

declare module "virtual:starlight/components/Search" {
  const Search: typeof import("@astrojs/starlight/components/Search.astro").default;
  export default Search;
}
declare module "virtual:starlight/components/SiteTitle" {
  const SiteTitle: typeof import("@astrojs/starlight/components/SiteTitle.astro").default;
  export default SiteTitle;
}
declare module "virtual:starlight/components/SocialIcons" {
  const SocialIcons: typeof import("@astrojs/starlight/components/SocialIcons.astro").default;
  export default SocialIcons;
}
declare module "virtual:starlight/components/ThemeSelect" {
  const ThemeSelect: typeof import("@astrojs/starlight/components/ThemeSelect.astro").default;
  export default ThemeSelect;
}
declare module "virtual:starlight/components/LanguageSelect" {
  const LanguageSelect: typeof import("@astrojs/starlight/components/LanguageSelect.astro").default;
  export default LanguageSelect;
}
