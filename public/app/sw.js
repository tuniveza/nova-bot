// Nova Hub's "doorman" (service worker). It lives on the phone and wakes up
// when Apple delivers a notification, even if Nova Hub is closed.

// A notification has arrived from Apple
self.addEventListener("push", (event) => {
  // Unpack the title, text and where to go when it's tapped (or use plain defaults)
  const data = event.data ? event.data.json() : { title: "Nova Hub", body: "Something new in Nova Hub" };
  // Keep the doorman awake until the notification is on screen
  event.waitUntil(
    // Show the notification on the phone
    self.registration.showNotification(data.title || "Nova Hub", {
      // The main line of text
      body: data.body || "",
      // The Nova Hub icon shown next to it
      icon: "/app/icon-192.png",
      // Remember where to go when it's tapped
      data: { url: data.url || "/app/" },
    })
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
      // Bring that window to the front
      if (open) return open.focus();
      // Otherwise open the link
      return self.clients.openWindow(url);
    })
  );
});
