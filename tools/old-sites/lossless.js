// The old standalone Lossless audio site (nova-lossless-audio .workers.dev), retired: Lossless audio
// is a panel of Nova Agent now. Every page goes to Nova Agent with Lossless audio open (an invite's
// room code comes along); its old offline helper steps aside. Nothing was saved in the browser here.
// Deploy: npx wrangler deploy -c tools/old-sites/wrangler.lossless.jsonc

const AGENT = "https://novacane-worker.novacane-studio.workers.dev/agent/";

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/sw.js")) {
      return new Response(
        'self.addEventListener("install", () => self.skipWaiting());\nself.addEventListener("activate", (e) => e.waitUntil(self.registration.unregister()));\n',
        { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }
    return Response.redirect(AGENT + "?open=" + encodeURIComponent("/lossless/" + url.search), 301);
  },
};
