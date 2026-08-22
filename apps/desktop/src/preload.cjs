/**
 * Auto-login preload: the desktop shell owns the admin key, so the user
 * never sees a login screen. On every page load we make sure a server
 * session cookie exists; if not, we log in with the injected key and
 * land on the dashboard.
 */
const keyArg = process.argv.find((arg) => arg.startsWith("--mp-admin-key="));
const adminKey = keyArg === undefined ? "" : keyArg.slice("--mp-admin-key=".length);

async function ensureSession() {
  if (adminKey.length === 0) return;
  try {
    const status = await fetch("/v1/auth/status", { credentials: "include" });
    const body = await status.json();
    if (body.authenticated === true && body.session_authenticated === true) return;
  } catch {
    // fall through to login
  }
  try {
    const res = await fetch("/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: adminKey }),
    });
    if (res.ok && window.location.pathname.startsWith("/login")) {
      window.location.assign("/");
    }
  } catch {
    // The login page remains usable as a fallback.
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void ensureSession();
});
