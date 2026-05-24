import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "atpotato — a tiny studio for the atproto-verse",
  description:
    "atpotato is a little studio making fun apps, helpful tools, and approachable content for the atproto and bsky ecosystem.",
  metadataBase: new URL("https://atpota.to"),
  openGraph: {
    title: "atpotato",
    description:
      "a tiny studio making fun apps and helpful tools for the atproto-verse",
    url: "https://atpota.to",
    images: ["/og-image.jpg"],
    type: "website",
  },
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="https://use.typekit.net/jik6ttx.css" />
        <link
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        <script
          // Apply theme before paint to avoid flash
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
