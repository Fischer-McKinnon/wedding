import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Allowed Google accounts (comma-separated emails in env var).
// If not set, any authenticated Google account is allowed.
const allowedEmails = process.env.ALLOWED_EMAILS
  ? process.env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase())
  : [];

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    authorized({ auth: session, request: { nextUrl } }) {
      const { pathname } = nextUrl;

      // Always allow NextAuth internal routes
      if (pathname.startsWith("/api/auth")) return true;

      const isLoggedIn = !!session?.user;
      if (!isLoggedIn) return false;

      // If ALLOWED_EMAILS is configured, enforce the allowlist
      if (allowedEmails.length > 0) {
        const userEmail = session.user?.email?.toLowerCase() ?? "";
        if (!allowedEmails.includes(userEmail)) return false;
      }

      return true;
    },
  },
});
