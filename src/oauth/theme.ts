/**
 * The look of the pages this worker shows in the browser (approval and message pages). It
 * follows the sign-in page of exciting IT's customer portal: wordmark with an accent dot, a
 * large display title, and the brand artwork on the right half of wide screens.
 *
 * DEPLOYING YOUR OWN: this file and `public/brand/` are the branding. Change the values here
 * and replace the files there. Everything is a build-time constant; nothing in a request can
 * change a colour, a font or an image address. All files are served from this worker's own
 * origin, so the pages load nothing from anywhere else.
 */
export const THEME = {
  /** Shown top left, followed by a dot in the accent colour. */
  wordmark: "exciting IT",
  colors: {
    background: "#f2f6f3",
    backgroundDeep: "#eaf0ec",
    ink: "#0e4623",
    wordmark: "#0e4624",
    muted: "#5b6f63",
    primary: "#2f6844",
    primaryHover: "#245236",
    onPrimary: "#ffffff",
    border: "#d5e2da",
    surface: "rgba(255, 255, 255, 0.65)",
    soft: "rgba(231, 239, 233, 0.85)",
    ring: "rgba(47, 104, 68, 0.55)",
    accent: "#dbbf93",
  },
  fonts: {
    /** Variable fonts, Latin subset, SIL Open Font License (texts next to the files). */
    display: { family: "Bricolage Grotesque", src: "/brand/fonts/bricolage-grotesque.woff2", weight: "200 800" },
    body: { family: "Instrument Sans", src: "/brand/fonts/instrument-sans.woff2", weight: "400 700" },
  },
  icon: "/brand/favicon.svg",
  /** The right half on wide screens. The image is decoration; the lines are the brand's claim. */
  artwork: {
    src: "/brand/artwork.jpg",
    claim: {
      de: {
        lines: ["Alles für deine", "digitale Präsenz"],
        text: "Verbinde dein Postfach sicher mit deinem KI-Werkzeug, ohne dein Passwort weiterzugeben.",
      },
      en: {
        lines: ["Everything for your", "digital presence"],
        text: "Connect your mailbox to your AI tool securely, without sharing your password.",
      },
    },
  },
} as const;
