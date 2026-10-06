// Nova Hub's "doorman" (service worker). It lives on the phone and wakes up
// when Apple delivers a notification, even if Nova Hub is closed.

// How each kind of notification buzzes (on phones that can; iPhones use their own sound)
const BUZZ = {
  checkin: [220, 90, 220, 90, 420],
  leave: [320, 120, 320, 120, 320],
  starting: [260, 110, 260],
  mission: [90, 60, 90, 60, 90, 60, 520],
  agent: [500, 150, 500],
};

// A notification has arrived from Apple
self.addEventListener("push", (event) => {
  // Unpack the title, text and where to go when it's tapped (or use plain defaults)
  const data = event.data ? event.data.json() : { title: "Nova Hub", body: "Something new in Nova Hub" };
  // Keep the doorman awake until the notification is on screen
  event.waitUntil(
    Promise.all([
      // Show the notification on the phone
      self.registration.showNotification(data.title || "Nova Hub", {
        // The main line of text
        body: data.body || "",
        // The Nova Hub icon shown next to it
        icon: "/app/icon-192.png",
        // The small icon in the status bar (Android)
        badge: "/app/icon-192.png",
        // A newer reminder about the same quest replaces the older one, and still rings
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        // A buzz pattern for its kind (Android), and never silent
        vibrate: BUZZ[data.kind] || BUZZ[data.source] || [200, 100, 200],
        silent: false,
        // Check-ins and Nova Agent problems stay on screen until they're answered
        requireInteraction: data.urgent === true,
        // When it happened
        timestamp: Date.now(),
        // Remember where to go when it's tapped
        data: { url: data.url || "/app/" },
      }),
      // A dot on the Home Screen icon until Nova Hub is opened
      self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null,
      // If Nova Hub is open, tell it too, so it can ping and show a banner straight away
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => windows.forEach((w) => w.postMessage({ type: "nova-push", ...data }))),
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
