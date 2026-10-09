import { useState } from "react";

/**
 * The studio's light/dark theme. Dark is the default; an explicit choice is
 * persisted to `localStorage` under the same key `index-html-template.ts`'s
 * inline head script reads, so a saved preference applies before first paint.
 */
export type StudioTheme = "light" | "dark";

const STORAGE_KEY = "boboddy-studio-theme";

function currentTheme(): StudioTheme {
  return document.documentElement.dataset["theme"] === "light" ? "light" : "dark";
}

export function useStudioTheme(): { theme: StudioTheme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<StudioTheme>(currentTheme);

  function toggleTheme(): void {
    const next: StudioTheme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset["theme"] = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still applies for this tab.
    }
    setTheme(next);
  }

  return { theme, toggleTheme };
}
