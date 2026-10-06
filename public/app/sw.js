// Nova Hub's "doorman" (service worker). It lives on the phone and wakes up
// when Apple delivers a notification, even if Nova Hub is closed.

// A new version of the doorman takes over straight away (instead of waiting
// until every Nova Hub window has been closed), so fixes reach the phone at once
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// How each kind of notification buzzes (on phones that can; iPhones use their own sound)
const BUZZ = {
  checkin: [220, 90, 220, 90, 420],
  pulse: [140],
  leave: [320, 120, 320, 120, 320],
  starting: [260, 110, 260],
  mission: [90, 60, 90, 60, 90, 60, 520],
  agent: [500, 150, 500],
};

// A notification has arrived from Apple
self.addEventListener("push", (event) => {
  // Unpack the title, text and where to go when it's tapped (or use plain defaults)
  const data = event.data ? event.data.json() : { title: "Nova Hub", body: "Something new in Nova Hub" };
  // The plain version: title, text, icon and where to go (what every phone shows, iPhones included)
  const plain = { body: data.body || "", icon: "/app/icon-192.png", data: { url: data.url || "/app/" } };
  // The rich version adds a buzz pattern, a tag (a newer one replaces the older one), and
  // staying on screen for check-ins. iPhones only get the plain version, and if a phone
  // turns the rich one down, it falls back to plain, so nothing is ever lost.
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent);
  const rich = {
    ...plain,
    badge: "/app/icon-192.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    vibrate: BUZZ[data.kind] || BUZZ[data.source] || [200, 100, 200],
    requireInteraction: data.urgent === true,
  };
  const show = () =>
    (isApple ? self.registration.showNotification(data.title || "Nova Hub", plain) : self.registration.showNotification(data.title || "Nova Hub", rich))
      .catch(() => self.registration.showNotification(data.title || "Nova Hub", plain));
  // Keep the doorman awake until the notification is on screen
  event.waitUntil(
    Promise.all([
      // Show the notification on the phone
      show(),
      // A dot on the Home Screen icon until Nova Hub is opened (never allowed to stop the notification)
      self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null,
      // If Nova Hub is open, tell it too, so it can ping and show a banner straight away
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => windows.forEach((w) => w.postMessage({ type: "nova-push", ...data }))).catch(() => {}),
    ])
  );
});

// The notification was tapped
self.addEventListener("notificationclick", (event) => {
  // Put the notification away
  event.notification.close();
  // Where this notification should take him (Nova Hub, or Acuity for bookings)
  const url = event.notification.data?.url || "/app/";
  // Keep the doorman awake until the right screen is open
  event.waitUntil(
    // Look for Nova Hub windows that are already open
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // For a Nova Hub link, reuse an open Nova Hub window if there is one
      const open = url.startsWith("/app/") && windows.find((w) => w.url.includes("/app/"));
      // Bring that window to the front, on the right tab
      if (open) {
        open.postMessage({ type: "nova-open", url });
        return open.focus();
      }
      // Otherwise open the link
      return self.clients.openWindow(url);
    })
  );
});
