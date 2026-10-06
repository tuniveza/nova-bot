// Nova Hub: the staff app. All data comes from /app/api/ (staff login
// needed). Everything from the server is shown as plain text, never as HTML.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let enquiryFilter = "all";
  let currentView = "enquiries";
  let sessions = null; // session types for booking links
  let sheetEnquiry = null;
  const botHistory = [];
  let lastAlerts = []; // the alerts last shown (for voice commands)
  let lastEnquiries = []; // the enquiries last shown (for voice commands)

  // ===== Talking to the Worker =====

  async function api(path, options = {}) {
    const res = await fetch("/app/api/" + path, {
      method: options.body ? "POST" : "GET",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {}
    if (res.status === 401 && path !== "login") {
      showLogin();
      throw new Error("signed out");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + ")");
    return data;
  }

  // ===== Little helpers =====

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function when(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return date.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function toast(message) {
    const t = $("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2200);
  }

  // Text with web links made clickable (links only, nothing else from the text)
  function linkify(node, text) {
    String(text).split(/(https?:\/\/[^\s<>"']+)/).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) node.appendChild(document.createTextNode(part));
        return;
      }
      const trail = part.match(/[.,!?;:)]+$/);
      const url = trail ? part.slice(0, -trail[0].length) : part;
      const a = el("a", "", /acuityscheduling|\/(book\?|pay\/|booking\/)/.test(url) ? "Booking link" : /calendar\.google\.com|google\.com\/calendar/.test(url) ? "Google Calendar" : url.replace(/^https?:\/\//, ""));
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      node.appendChild(a);
      if (trail) node.appendChild(document.createTextNode(trail[0]));
    });
  }

  // Booking or enquiry details, coloured line by line: the first line stands out,
  // "Label: value" lines get a rose label, days and times are gold
  function richDetails(text) {
    // The paragraph that holds the lines
    const box = el("p", "details");
    // Each line
    String(text).split("\n").forEach((line, i) => {
      // One line of text
      const row = el("span", "d-line");
      // "Label: value"?
      const pair = line.match(/^([^:]{1,60}):\s(.+)$/);
      // A day or a time ("Thursday, 22 October 2026, 14:15–16:15")
      const isWhen = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b|\b\d{1,2}:\d{2}\b/.test(line);
      // A labelled line: coloured label, then the value ("Was:" values are crossed out)
      if (pair) {
        row.append(el("span", "d-label", pair[1] + ": "), el("span", pair[1] === "Was" ? "d-was" : "d-value", pair[2]));
      } else {
        // A day or time is gold; the first line (the session) stands out
        if (isWhen) row.classList.add("d-when");
        else if (i === 0) row.classList.add("d-first");
        // The words
        row.textContent = line;
      }
      // Add the line
      box.appendChild(row);
    });
    // Hand it back
    return box;
  }

  function emptyState(list, text) {
    list.replaceChildren(el("p", "empty", text));
  }

  // ===== Signing in and out =====

  function showLogin() {
    $("app").hidden = true;
    $("login").hidden = false;
    $("password").value = "";
    setTimeout(() => $("password").focus(), 50);
  }

  function showApp() {
    $("login").hidden = true;
    $("app").hidden = false;
    // Opened from a Nova Agent, Nova Quest or Nova Mission notification: go straight to Alerts
    if (location.hash === "#nova") currentView = "alerts";
    show(currentView);
    // The Quests badge (quests left today), whatever tab is open
    loadQuests();
    // Light the bell up if this phone already gets notifications
    updateNotifyPanel();
    // Hands-free voice: the mic glows, and listening starts
    $("voice").classList.toggle("on", handsFree);
    startHandsFree();
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    const button = e.target.querySelector("button");
    button.disabled = true;
    try {
      await api("login", { body: { password: $("password").value } });
      showApp();
    } catch (err) {
      $("login-error").textContent = err.message;
    }
    button.disabled = false;
  });

  $("logout").addEventListener("click", async () => {
    try {
      await api("logout", { body: {} });
    } catch (err) {}
    showLogin();
  });

  // ===== Switching sections =====

  function show(view) {
    currentView = view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    ["enquiries", "chats", "calendar", "quests", "alerts", "bot"].forEach((v) => ($("view-" + v).hidden = v !== view));
    if (view === "quests") loadQuests();
    if (view === "enquiries") loadEnquiries();
    if (view === "chats") loadChats();
    if (view === "calendar") loadCalendar();
    // Every section keeps the Alerts badge up to date; the Alerts tab also shows the list
    loadAlerts();
    if (view === "bot") setTimeout(() => $("bot-input").focus(), 50);
  }

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.view)));
  $("refresh").addEventListener("click", () => {
    show(currentView);
    toast("Refreshed");
  });
  // Coming back to the app: get the latest
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("app").hidden && currentView !== "bot") show(currentView);
  });

  // ===== Enquiries =====

  document.querySelectorAll("[data-show]").forEach((chip) =>
    chip.addEventListener("click", () => {
      enquiryFilter = chip.dataset.show;
      document.querySelectorAll("[data-show]").forEach((c) => c.classList.toggle("active", c === chip));
      loadEnquiries();
    })
  );

  async function loadEnquiries() {
    const list = $("enquiry-list");
    try {
      const data = await api("enquiries" + (enquiryFilter === "all" ? "?show=all" : ""));
      lastEnquiries = data.enquiries;
      $("new-badge").hidden = !data.newCount;
      $("new-badge").textContent = data.newCount;
      if (!data.enquiries.length) {
        return emptyState(list, enquiryFilter === "all" ? "No enquiries yet." : "No new enquiries. They appear here when a customer asks NovaBot to send one.");
      }
      list.replaceChildren(...data.enquiries.map(enquiryCard));
    } catch (err) {
      if (err.message !== "signed out") emptyState(list, err.message);
    }
  }

  function enquiryCard(q) {
    const card = el("article", "card" + (q.status === "done" ? " done" : ""));
    const top = el("div", "card-top");
    const title = el("h3", "card-title", q.subject || "Enquiry");
    if (q.status === "new") title.appendChild(el("span", "pill-new", "New"));
    else title.appendChild(el("span", "pill-done", "Done"));
    top.append(title, el("span", "card-meta", when(q.created_at)));
    card.append(top, el("p", "card-who", q.name + " · " + q.email + (q.phone ? " · " + q.phone : "")));
    card.appendChild(el("p", "details", q.details));
    card.appendChild(el("p", "card-foot", [q.page ? "From " + q.page : "", q.emailed ? "Email copy sent" : ""].filter(Boolean).join(" · ")));

    const actions = el("div", "actions");
    const reply = el("a", "btn small", "Email");
    reply.href = "mailto:" + encodeURIComponent(q.email) + "?subject=" + encodeURIComponent("Re: " + (q.subject || "Your Novacane enquiry"));
    actions.appendChild(reply);
    if (q.phone) {
      const call = el("a", "btn small ghost", "Call");
      call.href = "tel:" + q.phone.replace(/[^0-9+]/g, "");
      actions.appendChild(call);
    }
    const link = el("button", "btn small ghost", "Booking link");
    link.type = "button";
    link.addEventListener("click", () => openSheet(q));
    actions.appendChild(link);
    if (q.chat_id) {
      const chat = el("button", "btn small ghost", "Read chat");
      chat.type = "button";
      chat.addEventListener("click", () => {
        show("chats");
        openChat(q.chat_id, q.name);
      });
      actions.appendChild(chat);
    }
    const done = el("button", "btn small ghost", q.status === "done" ? "Move to new" : "Mark done");
    done.type = "button";
    done.addEventListener("click", async () => {
      done.disabled = true;
      try {
        await api("enquiries/status", { body: { id: q.id, status: q.status === "done" ? "new" : "done" } });
        toast(q.status === "done" ? "Moved back to new" : "Marked done");
        loadEnquiries();
      } catch (err) {
        toast(err.message);
        done.disabled = false;
      }
    });
    actions.appendChild(done);
    card.appendChild(actions);
    return card;
  }

  // ===== Booking link sheet =====

  async function openSheet(q) {
    sheetEnquiry = q;
    $("sheet-for").textContent = "For " + q.name + " (" + q.email + ")";
    $("sheet-result").hidden = true;
    $("sheet-error").textContent = "";
    $("sheet").hidden = false;
    if (!sessions) {
      try {
        sessions = (await api("sessions")).sessions;
      } catch (err) {
        $("sheet-error").textContent = err.message;
        return;
      }
    }
    $("sheet-session").replaceChildren(
      ...sessions.map((s) => {
        const option = el("option", "", s.name + (s.price ? " (" + s.price + ")" : ""));
        option.value = s.id;
        return option;
      })
    );
  }

  $("sheet-make").addEventListener("click", async () => {
    $("sheet-error").textContent = "";
    try {
      const data = await api("booking-link", { body: { enquiryId: sheetEnquiry.id, typeId: Number($("sheet-session").value) } });
      $("sheet-link").value = data.url;
      const first = sheetEnquiry.name.split(/\s+/)[0];
      const body =
        "Hi " + first + ",\n\nThanks for your enquiry. You can book your session here: pick a time on the calendar and pay the deposit to confirm.\n\n" +
        data.session + "\n" + data.url + "\n\nNovacane Studios";
      $("sheet-email").href =
        "mailto:" + encodeURIComponent(sheetEnquiry.email) + "?subject=" + encodeURIComponent("Booking your session at Novacane") + "&body=" + encodeURIComponent(body);
      $("sheet-result").hidden = false;
    } catch (err) {
      $("sheet-error").textContent = err.message;
    }
  });

  $("sheet-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("sheet-link").value);
      toast("Link copied");
    } catch (err) {
      $("sheet-link").select();
      toast("Select the link and copy it");
    }
  });

  $("sheet-close").addEventListener("click", () => ($("sheet").hidden = true));
  $("sheet").addEventListener("click", (e) => {
    if (e.target === $("sheet")) $("sheet").hidden = true;
  });

  // ===== Conversations =====

  async function loadChats() {
    $("chats-back").hidden = true;
    $("chats-title").textContent = "Conversations";
    $("chats-hint").hidden = false;
    const list = $("chat-list");
    try {
      const data = await api("conversations");
      if (!data.conversations.length) return emptyState(list, "No conversations yet.");
      list.replaceChildren(
        ...data.conversations.map((c) => {
          const card = el("article", "card tappable");
          const top = el("div", "card-top");
          const title = el("h3", "card-title", (c.first_question || "(no question)").slice(0, 120));
          if (c.enquiries) title.appendChild(el("span", "pill-new", "Enquiry"));
          top.append(title, el("span", "card-meta", when(c.started)));
          card.append(top, el("p", "card-foot", c.messages + (c.messages === 1 ? " message" : " messages")));
          card.addEventListener("click", () => openChat(c.chat_id));
          return card;
        })
      );
    } catch (err) {
      if (err.message !== "signed out") emptyState(list, err.message);
    }
  }

  async function openChat(chatId, name) {
    $("chats-back").hidden = false;
    $("chats-hint").hidden = true;
    $("chats-title").textContent = name ? "Chat with " + name.split(/\s+/)[0] : "Chat";
    const list = $("chat-list");
    try {
      const data = await api("conversations?chat=" + encodeURIComponent(chatId));
      if (!data.messages.length) return emptyState(list, "This chat has been deleted (chats are kept for 90 days).");
      const card = el("article", "card");
      data.messages.forEach((m) => {
        const line = el("div", "line " + (m.role === "user" ? "visitor" : "bot"));
        line.appendChild(el("span", "who", (m.role === "user" ? "Customer" : "NovaBot") + " · " + when(m.created_at) + (m.page ? " · " + m.page : "")));
        const p = el("p");
        linkify(p, m.content);
        line.appendChild(p);
        card.appendChild(line);
      });
      list.replaceChildren(card);
      window.scrollTo(0, 0);
    } catch (err) {
      if (err.message !== "signed out") emptyState(list, err.message);
    }
  }

  $("chats-back").addEventListener("click", loadChats);

  // ===== Calendar =====
  // Every booking in Acuity's diary, as a month you can swipe through. Tap a
  // day to see its bookings with every detail, and call or email from there.

  // The bookings (loaded once, then refreshed when the tab opens)
  let calBookings = [];
  // Which month is showing ({ year, month } with month 0–11)
  let calMonth = null;
  // Which day is picked ("2026-10-22")
  let calPicked = null;
  // Colours for the different sessions (each session always gets the same one)
  const CAL_COLOURS = ["#ff5fa8", "#b98bff", "#ffd08a", "#7fd8ff", "#ff9d6e", "#8ef0c0"];

  // A day as "2026-10-22", in UK time
  function dayKey(date) {
    return date.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  }

  // The feed's time ("20261022T131500Z") as a real date
  function feedDate(value) {
    // Its parts: year, month, day, hour, minute
    const m = String(value || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    // A date, or nothing
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
  }

  // A time of day in UK time ("14:15")
  function clock(date) {
    return date.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  }

  // A session's colour (the same session always gets the same colour)
  function sessionColour(name) {
    // Add up the letters to pick a colour
    let sum = 0;
    for (const c of String(name)) sum += c.charCodeAt(0);
    // That colour
    return CAL_COLOURS[sum % CAL_COLOURS.length];
  }

  // Get the bookings and draw the calendar
  async function loadCalendar() {
    // Today, in UK time
    const today = dayKey(new Date());
    // First visit: show this month, with today picked
    if (!calMonth) {
      calMonth = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 };
      calPicked = today;
    }
    // Draw what we have straight away
    drawMonth();
    drawDay();
    // Then get the latest bookings
    try {
      // Ask the Worker for the diary
      const data = await api("calendar");
      // The feed isn't set up
      if (!data.setUp) {
        $("cal-day-list").replaceChildren(el("p", "empty", "The Acuity calendar feed isn't set up yet."));
        return;
      }
      // Each booking with its start and end as real dates
      calBookings = data.bookings
        .map((b) => ({ ...b, from: feedDate(b.start), to: feedDate(b.end) }))
        .filter((b) => b.from);
      // Draw again with them (no slide animation)
      drawMonth();
      drawDay();
    } catch (err) {
      // Show the problem
      if (err.message !== "signed out") $("cal-day-list").replaceChildren(el("p", "empty", err.message));
    }
  }

  // The bookings on one day ("2026-10-22"), earliest first
  // Nova Calendar's cards and Nova Quests on a day (sent by Nova Agent with its plan)
  function suiteOn(key) {
    const st = lastQuests && lastQuests.state;
    if (!st) return [];
    const items = [];
    const cal = st.calendar || { notes: [], days: [] };
    // Day cards (a whole day: birthdays, release days...), including yearly ones
    for (const d of cal.days || []) if (d.date === key || (d.repeat === "yearly" && d.date.slice(5) === key.slice(5))) items.push({ kind: "day", title: d.title, sub: [d.info, d.location].filter(Boolean).join(" · "), sort: "" });
    // Note cards (at a time)
    for (const n of cal.notes || []) if (n.start.slice(0, 10) <= key && n.end.slice(0, 10) >= key) items.push({ kind: "note", title: n.title || "Note card", sub: n.body, time: n.start.slice(0, 10) === key ? hhmm(n.start) + "–" + hhmm(n.end) : "all day", sort: n.start });
    // Planned quests
    for (const q of st.quests || []) if (q.start && q.start.slice(0, 10) === key && q.status !== "skipped") items.push({ kind: "quest", title: (q.status === "done" ? "✓ " : "") + q.title, sub: length(q), time: hhmm(q.start) + "–" + hhmm(q.end), sort: q.start });
    return items.sort((a, b) => a.sort.localeCompare(b.sort));
  }

  // One Nova Calendar card or quest, in the Calendar tab
  function suiteCard(item) {
    const card = el("article", "card cal-card suite-item " + item.kind);
    card.appendChild(el("span", "alert-kind " + (item.kind === "quest" ? "quest" : "other"), item.kind === "quest" ? "Nova Quest" : item.kind === "day" ? "Nova Calendar · day" : "Nova Calendar"));
    if (item.time) card.appendChild(el("p", "cal-time", item.time));
    card.appendChild(el("h3", "card-title", item.title));
    if (item.sub) card.appendChild(el("p", "cal-session", item.sub));
    return card;
  }

  function bookingsOn(key) {
    return calBookings.filter((b) => dayKey(b.from) === key).sort((a, b) => a.from - b.from);
  }

  // Draw the month grid. `slide` is "left" or "right" when changing month.
  function drawMonth(slide) {
    // The month's name ("October 2026")
    const first = new Date(Date.UTC(calMonth.year, calMonth.month, 1, 12));
    $("cal-month").textContent = first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    // How many blank days before the 1st (weeks start on Monday)
    const lead = (first.getUTCDay() + 6) % 7;
    // How many days in the month
    const days = new Date(Date.UTC(calMonth.year, calMonth.month + 1, 0)).getUTCDate();
    // Today
    const today = dayKey(new Date());
    // The cells: blanks, then one per day, then blanks to finish the last week
    const cells = [];
    // Blanks before
    for (let i = 0; i < lead; i++) cells.push(el("span", "cal-blank"));
    // One per day
    for (let d = 1; d <= days; d++) {
      // This day as "2026-10-22"
      const key = calMonth.year + "-" + String(calMonth.month + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      // Its bookings
      const list = bookingsOn(key);
      // The day's button
      const cell = el("button", "cal-day");
      cell.type = "button";
      // Today, the picked day, busy days and past days look different
      if (key === today) cell.classList.add("today");
      if (key === calPicked) cell.classList.add("picked");
      if (list.length) cell.classList.add("busy");
      if (key < today) cell.classList.add("past");
      // Read out properly by screen readers
      cell.setAttribute("aria-label", d + " " + $("cal-month").textContent + (list.length ? ", " + list.length + (list.length === 1 ? " booking" : " bookings") : ""));
      // The date number
      cell.appendChild(el("span", "cal-num", d));
      // A coloured dot per booking (up to three, then "+2")
      const dots = el("span", "cal-dots");
      list.slice(0, 3).forEach((b) => {
        const dot = el("i");
        dot.style.background = sessionColour(b.session);
        dots.appendChild(dot);
      });
      if (list.length > 3) dots.appendChild(el("b", "", "+" + (list.length - 3)));
      // A lilac dot when Nova Calendar or Nova Quests have something that day
      if (suiteOn(key).length) {
        const dot = el("i", "suite-dot");
        dot.style.background = "#c7a4ff";
        dots.appendChild(dot);
        cell.classList.add("busy");
      }
      cell.appendChild(dots);
      // Tapping it picks the day
      cell.addEventListener("click", () => {
        calPicked = key;
        drawMonth();
        drawDay(true);
      });
      cells.push(cell);
    }
    // Blanks after, to finish the week
    while (cells.length % 7) cells.push(el("span", "cal-blank"));
    // Put them in
    const grid = $("cal-grid");
    grid.replaceChildren(...cells);
    // Slide in from the side when the month changes
    grid.classList.remove("from-left", "from-right");
    if (slide) {
      void grid.offsetWidth; // restart the animation
      grid.classList.add(slide === "left" ? "from-left" : "from-right");
    }
  }

  // Draw the picked day's bookings under the calendar
  function drawDay(animate) {
    // The picked day as a date
    const date = new Date(calPicked + "T12:00:00Z");
    // Its name ("Thursday 22 October")
    const name = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    // Its bookings
    const list = bookingsOn(calPicked);
    // The heading
    $("cal-day-title").textContent = name + (list.length ? " · " + list.length + (list.length === 1 ? " booking" : " bookings") : "");
    // The list
    const box = $("cal-day-list");
    // Nova Calendar's cards and Nova Quests that day, after the bookings
    const suite = suiteOn(calPicked);
    if (suite.length) return box.replaceChildren(...list.map((b, i) => calCard(b, animate ? i : -1)), ...suite.map(suiteCard));
    // None that day: say so, and offer the next booking
    if (!list.length) {
      // The next booking after that day
      const next = calBookings.filter((b) => dayKey(b.from) > calPicked).sort((a, b) => a.from - b.from)[0];
      // The message
      const empty = el("div", "empty");
      empty.appendChild(el("p", "", "No bookings this day."));
      // A button to jump to the next booking
      if (next) {
        const jump = el("button", "chip", "Next: " + next.from.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" }) + " · " + (next.name || next.session));
        jump.type = "button";
        jump.addEventListener("click", () => pickDay(dayKey(next.from)));
        empty.appendChild(jump);
      }
      return box.replaceChildren(empty);
    }
    // One card per booking (sliding in one after another)
    box.replaceChildren(...list.map((b, i) => calCard(b, animate ? i : -1)));
  }

  // Jump to a day (changing month if needed)
  function pickDay(key) {
    // The month it's in
    const month = { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 };
    // Which way to slide
    const slide = month.year * 12 + month.month > calMonth.year * 12 + calMonth.month ? "right" : month.year * 12 + month.month < calMonth.year * 12 + calMonth.month ? "left" : null;
    // Show it
    calMonth = month;
    calPicked = key;
    drawMonth(slide);
    drawDay(true);
  }

  // One booking, as a card
  function calCard(b, order) {
    // The card, edged in the session's colour
    const card = el("article", "card cal-card");
    card.style.setProperty("--c", sessionColour(b.session));
    // Slide in, one after another
    if (order >= 0) {
      card.style.setProperty("--i", order);
      card.classList.add("cal-in");
    }
    // The time ("14:15 – 16:15")
    card.appendChild(el("p", "cal-time", clock(b.from) + (b.to ? " – " + clock(b.to) : "")));
    // The customer's name, then the session
    card.appendChild(el("h3", "card-title", b.name || "Booking"));
    card.appendChild(el("p", "cal-session", b.session || ""));
    // Price, phone, email and any form answers, coloured
    const lines = [b.price && "Price: " + b.price, b.phone && "Phone: " + b.phone, b.email && "Email: " + b.email, ...(b.extra || []).map(([l, v]) => l + ": " + v)].filter(Boolean);
    if (lines.length) card.appendChild(richDetails(lines.join("\n")));
    // Buttons: call, email, open in Acuity
    const actions = el("div", "actions");
    if (b.phone) {
      const call = el("a", "btn small", "Call");
      call.href = "tel:" + b.phone.replace(/[^0-9+]/g, "");
      actions.appendChild(call);
    }
    if (b.email) {
      const email = el("a", "btn small ghost", "Email");
      email.href = "mailto:" + encodeURIComponent(b.email);
      actions.appendChild(email);
    }
    // A booking made with Nova Bot's own system opens in Google Calendar; anything else in Acuity
    const acuity = el("a", "btn small ghost", b.link ? "Open in Google Calendar" : "Open in Acuity");
    Object.assign(acuity, { href: b.link || "https://secure.acuityscheduling.com/appointments.php", target: "_blank", rel: "noopener" });
    actions.appendChild(acuity);
    card.appendChild(actions);
    // Hand it back
    return card;
  }

  // Change month (+1 next, -1 previous)
  function changeMonth(step) {
    // Move the month
    const total = calMonth.year * 12 + calMonth.month + step;
    calMonth = { year: Math.floor(total / 12), month: total % 12 };
    // Draw it, sliding in from the right side
    drawMonth(step > 0 ? "right" : "left");
  }

  // The arrows and "Today"
  $("cal-prev").addEventListener("click", () => changeMonth(-1));
  $("cal-next").addEventListener("click", () => changeMonth(1));
  $("cal-today").addEventListener("click", () => pickDay(dayKey(new Date())));

  // Swipe left or right on the month to change it
  let swipeFrom = null;
  $("cal-grid").addEventListener("touchstart", (e) => (swipeFrom = e.touches[0].clientX), { passive: true });
  $("cal-grid").addEventListener("touchend", (e) => {
    // How far the finger moved sideways
    const moved = swipeFrom === null ? 0 : e.changedTouches[0].clientX - swipeFrom;
    swipeFrom = null;
    // Far enough to count as a swipe
    if (Math.abs(moved) > 50) changeMonth(moved < 0 ? 1 : -1);
  });

  // ===== Nova Quests =====
  // Nova Agent (on the studio computer) sends its plan here every time it
  // changes. Taps (Done, Start, Not now...) go back to it, usually within a second.

  // Which part is showing: today, missions, or every quest
  let questTab = "today";
  // The last plan we got (for redrawing without asking again)
  let lastQuests = null;

  // "14:30" from "2026-10-09T14:30" (with seconds if it has them)
  const hhmm = (s) => (s ? s.slice(11, s.length > 16 ? 19 : 16) : "");
  // "30 s", "45 min", "1 h 30 min", "3 days 4 h"; repeats: "∞ · 30 s every 2 min"
  function length(q) {
    const plain = (minutes) => {
      const secs = Math.round(minutes * 60);
      if (secs < 60) return secs + " s";
      const m = Math.floor(secs / 60), s = secs % 60;
      if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
      const h = Math.floor(m / 60), mm = m % 60;
      if (h < 48) return mm ? `${h} h ${mm} min` : `${h} h`;
      return `${Math.floor(h / 24)} days ${h % 24 ? (h % 24) + " h" : ""}`.trim();
    };
    if (!q.ongoing) return plain(q.minutes);
    const every = q.every === "interval" ? "every " + plain(q.everyMinutes) : q.every === "week" ? "a week" : q.every === "weekday" ? "each weekday" : "a day";
    return `∞ · ${plain(q.minutes)} ${every}`;
  }
  // A day's name: "Wednesday 7 October"
  const dayName = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  // Get the plan and draw the open part
  async function loadQuests() {
    try {
      const data = await api("quests");
      lastQuests = data;
      drawQuests();
    } catch (err) {
      if (err.message !== "signed out" && currentView === "quests") emptyState($("quests-body"), err.message);
    }
  }

  // Send a tap to Nova Agent, then look again a moment later
  async function questTap(id, action, kind = "quest", minutes) {
    try {
      await api("quests/action", { body: { id, action, kind, minutes } });
      toast(lastQuests && lastQuests.online ? "Sent to Nova Agent" : "Sent: Nova Agent will do it when it's back online");
      setTimeout(loadQuests, 1500);
      setTimeout(loadQuests, 4000);
    } catch (err) {
      if (err.message !== "signed out") toast(err.message);
    }
  }

  // A small button
  function questButton(label, onClick, primary) {
    const b = el("button", "btn small" + (primary ? "" : " ghost"), label);
    b.type = "button";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      b.disabled = true;
      onClick();
    });
    return b;
  }

  // The buttons for one quest, depending on where it's at
  function questButtons(q) {
    const row = el("div", "actions");
    if (q.status === "todo") row.appendChild(questButton("▶ Start", () => questTap(q.id, "start"), true));
    if (q.status !== "done") row.appendChild(questButton(q.ongoing ? "✓ Session done" : "✓ Done", () => questTap(q.id, "done"), q.status === "doing"));
    if (q.status === "doing") row.appendChild(questButton("+15 min", () => questTap(q.id, "snooze", "quest", 15)));
    if (q.status === "todo" && !q.ongoing) row.appendChild(questButton("Not now", () => questTap(q.id, "snooze", "quest", 60)));
    if (q.status === "todo" && !q.ongoing) row.appendChild(questButton("Skip", () => questTap(q.id, "skip")));
    if (q.ongoing && q.status !== "done") row.appendChild(questButton("Stop", () => questTap(q.id, "finish")));
    if (q.status === "done" || q.status === "skipped") row.appendChild(questButton("Undo", () => questTap(q.id, "reopen")));
    return row;
  }

  // One quest as a card
  function questCard(q, missions, big) {
    const card = el("article", "card quest-card " + q.status + (q.atRisk ? " risk" : "") + (big ? " now" : ""));
    const mission = missions.find((m) => m.id === q.missionId);
    if (big) card.appendChild(el("span", "nova-label quest", q.status === "doing" ? "In progress" : "Up next"));
    const top = el("div", "card-top");
    top.append(el("h3", "card-title", (q.atRisk ? "⚠ " : q.ongoing ? "∞ " : "") + q.title), el("span", "card-meta", q.start ? hhmm(q.start) + "–" + hhmm(q.end) : "not planned yet"));
    card.appendChild(top);
    const bits = [length(q), q.priority];
    if (mission) bits.unshift(mission.title);
    if (q.location) bits.push("at " + q.location + (q.travelMinutes ? ` (leave ${hhmm(q.travelStart)})` : ""));
    if (q.deadline) bits.push("due " + q.deadline.replace("T", " "));
    card.appendChild(el("p", "quest-meta", bits.join(" · ")));
    if (q.status !== "done") card.appendChild(questButtons(q));
    return card;
  }

  // Draw the open part of the Quests tab
  function drawQuests() {
    const body = $("quests-body");
    const data = lastQuests;
    if (!data || !data.state) {
      $("quests-sync").textContent = "Nothing from Nova Agent yet. It sends its plan here once it's running the latest version.";
      return body.replaceChildren();
    }
    const st = data.state;
    const ago = data.at ? Math.round((Date.now() - Date.parse(data.at)) / 60000) : null;
    $("quests-sync").textContent = (data.online ? "● Nova Agent is online" : "○ Nova Agent is offline") + (ago !== null ? ` · updated ${ago < 1 ? "just now" : ago + " min ago"}` : "");
    const missions = st.missions || [];
    const quests = st.quests || [];
    const today = (st.now || "").slice(0, 10);
    const open = quests.filter((q) => q.status === "todo" || q.status === "doing");
    // The badge: quests left today
    const left = open.filter((q) => q.start && q.start.startsWith(today)).length;
    $("quest-badge").hidden = !left;
    $("quest-badge").textContent = left;
    // The Calendar tab shows Nova Calendar and quests too: redraw it with the latest
    if (currentView === "calendar" && calMonth) {
      drawMonth();
      drawDay();
    }
    if (currentView !== "quests") return;
    const cards = [];

    if (questTab === "today") {
      const current = st.current || (st.next || [])[0];
      if (current) cards.push(questCard(current, missions, true));
      for (const q of st.pulses || []) {
        const card = el("article", "card quest-card pulse");
        card.append(el("span", "nova-label quest", "Pulse"), el("h3", "card-title", "∞ " + q.title), el("p", "quest-meta", length(q) + (q.deadline ? " · until " + hhmm(q.deadline) : "")));
        card.appendChild(questButtons(q));
        cards.push(card);
      }
      const todays = quests.filter((q) => q.start && q.start.startsWith(today) && q.status !== "skipped" && (!current || q.id !== current.id)).sort((a, b) => a.start.localeCompare(b.start));
      if (todays.length) cards.push(el("h3", "quest-day", "Today · " + dayName(today)), ...todays.map((q) => questCard(q, missions)));
      const later = open.filter((q) => q.start && q.start.slice(0, 10) > today).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 12);
      let day = "";
      for (const q of later) {
        if (q.start.slice(0, 10) !== day) {
          day = q.start.slice(0, 10);
          cards.push(el("h3", "quest-day", dayName(day)));
        }
        cards.push(questCard(q, missions));
      }
      if (!cards.length) return emptyState(body, "Nothing planned. Ask Nova Agent for a mission, or add a quest.");
    }

    if (questTab === "missions") {
      if (!missions.length) return emptyState(body, "No missions yet. Ask Nova Agent: \"Plan a mission: finish the EP by 1 December\".");
      for (const m of missions) {
        const p = m.progress || { done: 0, total: 0, atRisk: 0, minutesLeft: 0 };
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        const card = el("article", "card mission-card " + m.status);
        const ring = el("div", "ring", pct + "%");
        ring.style.setProperty("--p", pct);
        const head = el("div", "mission-head");
        const words = el("div", "mission-words");
        words.append(el("h3", "card-title", m.title), el("p", "quest-meta", m.summary || ""));
        head.append(ring, words);
        card.append(el("span", "nova-label mission", m.status === "done" ? "Mission complete" : m.status === "paused" ? "Paused" : "Nova Mission"), head);
        card.appendChild(el("p", "quest-meta", [m.deadline ? "Due " + m.deadline.replace("T", " ") : "", `${p.done}/${p.total} quests`, (p.minutesLeft / 60).toFixed(1) + " h left", p.atRisk ? `⚠ ${p.atRisk} at risk` : ""].filter(Boolean).join(" · ")));
        const row = el("div", "actions");
        if (m.status === "active") row.appendChild(questButton("Pause", () => questTap(m.id, "pause", "mission")));
        if (m.status === "paused") row.appendChild(questButton("Resume", () => questTap(m.id, "resume", "mission"), true));
        card.appendChild(row);
        cards.push(card);
      }
    }

    if (questTab === "all") {
      const sorted = [...quests].sort((a, b) => (a.start || "z").localeCompare(b.start || "z"));
      if (!sorted.length) return emptyState(body, "No quests yet.");
      cards.push(...sorted.map((q) => questCard(q, missions)));
    }
    body.replaceChildren(...cards);
  }

  document.querySelectorAll("[data-quests]").forEach((chip) =>
    chip.addEventListener("click", () => {
      questTab = chip.dataset.quests;
      document.querySelectorAll("[data-quests]").forEach((c) => c.classList.toggle("active", c === chip));
      drawQuests();
    })
  );
  // While the Quests tab is open, keep it fresh
  setInterval(() => !document.hidden && currentView === "quests" && loadQuests(), 15000);

  // ===== Ambient music =====
  // Soft electronic ambient, made live on the phone (ambient.js). Remembered on this phone.
  const music = $("music");
  function musicState(on) {
    music.setAttribute("aria-pressed", on ? "true" : "false");
    music.classList.toggle("on", on);
    try { localStorage.setItem("novahub-music", on ? "1" : "0"); } catch (err) {}
  }
  if (window.NovaAmbient) {
    window.NovaAmbient.onchange = musicState;
    music.addEventListener("click", async () => {
      const on = await window.NovaAmbient.toggle();
      toast(on ? "Ambient music on ✦" : "Ambient music off");
    });
    // It was on last time: start again on the first tap (phones only allow sound after a tap)
    let wanted = false;
    try { wanted = localStorage.getItem("novahub-music") === "1"; } catch (err) {}
    if (wanted) document.addEventListener("pointerdown", function again(e) {
      if (e.target.closest("#music")) return;
      document.removeEventListener("pointerdown", again);
      window.NovaAmbient.start().catch(() => {});
    });
  } else music.hidden = true;

  // ===== Alerts =====
  // A copy of every notification that went through to a phone, newest first.
  // Like the pile of letters on the doormat: the badge counts the unopened ones.

  // The newest alert he has already seen (remembered on this phone only)
  function seenAlert() {
    // Read it, or 0 if this phone hasn't seen any yet (or can't remember)
    try {
      // The number saved last time
      return Number(localStorage.getItem("novahub-seen-alert")) || 0;
    } catch (err) {
      // This phone can't remember things: treat everything as unseen
      return 0;
    }
  }

  // Remember the newest alert he has now seen
  function markAlertsSeen(id) {
    // Save it, ignoring phones that can't
    try {
      // Write it down
      localStorage.setItem("novahub-seen-alert", String(id));
    } catch (err) {}
  }

  // Get the alerts, update the badge, and show the list if the Alerts tab is open
  async function loadAlerts() {
    // The list on the page
    const list = $("alert-list");
    // Try it, and show any problem in the list
    try {
      // Ask the Worker for the alerts and the auto-delete setting
      const { notifications, autoDeleteDays, choices } = await api("notifications");
      // Show the auto-delete switch's setting
      showAutoDelete(autoDeleteDays, choices);
      // Keep the list for voice commands ("call Eric")
      lastAlerts = notifications;
      // Is the Alerts tab the one on screen?
      const looking = currentView === "alerts";
      // He's looking at them: they count as seen
      if (looking && notifications.length) markAlertsSeen(notifications[0].id);
      // How many are newer than the last one he saw
      const unseen = notifications.filter((n) => n.id > seenAlert()).length;
      // Show the number on the tab, or hide it when there are none
      $("alert-badge").hidden = !unseen;
      // The number itself
      $("alert-badge").textContent = unseen;
      // Not on the Alerts tab: the badge is all we needed
      if (!looking) return;
      // Nothing yet: say so
      if (!notifications.length) return emptyState(list, "No alerts yet. New enquiries and bookings appear here once they've reached a phone.");
      // Draw one card per alert
      list.replaceChildren(...notifications.map(alertCard));
    } catch (err) {
      // Show the problem (unless he's just been signed out)
      if (err.message !== "signed out" && currentView === "alerts") emptyState(list, err.message);
    }
  }

  // Which Nova app an alert came from (from the start of its title), or null
  function novaSource(title) {
    // The three Nova apps that send alerts, and their colour names
    const sources = [["Nova Quest: ", "quest"], ["Nova Mission: ", "mission"], ["Nova Agent: ", "agent"]];
    // Find the one the title starts with
    const found = sources.find(([prefix]) => String(title).startsWith(prefix));
    // Its name (without the colon) and colour, or nothing
    return found ? { name: found[0].slice(0, -2), key: found[1] } : null;
  }

  // The label for each kind of alert
  const KIND_LABELS = { booking: "Booking · Acuity", "nova-booking": "Booking · Nova", enquiry: "Enquiry", quest: "Nova Quest", mission: "Nova Mission", agent: "Nova Agent", health: "Acuity connection", test: "Test", other: "Alert" };

  // "Tue 6 Oct 2026 · 21:02:40" (UK time, to the second)
  function exactTime(iso) {
    const d = new Date(iso);
    const day = d.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const time = d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `${day} · ${time}`;
  }
  // "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago"
  function ago(iso) {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + " h ago";
    const days = Math.round(hours / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }

  // What Acuity said about each booking (asked once per visit)
  const verified = new Map();
  // A panel that checks the booking with Acuity when it comes into view
  function verifyPanel(id) {
    const box = el("div", "verify checking");
    box.append(el("p", "verify-title", "Checking with Acuity…"), el("div", "verify-lines"));
    // Fill it in with what Acuity says
    const fill = (r) => {
      box.className = "verify " + r.status;
      const icon = { real: "✓ ", cancelled: "✕ ", missing: "⚠ " }[r.status] || "";
      box.querySelector(".verify-title").textContent = icon + r.title;
      box.querySelector(".verify-lines").replaceChildren(...(r.lines || []).map((line) => el("span", "", line)));
    };
    const check = () => {
      if (!verified.has(id)) verified.set(id, api("verify-booking?id=" + encodeURIComponent(id)).catch((err) => ({ status: "unknown", title: err.message, lines: [] })));
      verified.get(id).then(fill);
    };
    // Only ask Acuity about bookings that are actually on screen
    if ("IntersectionObserver" in window) {
      const seen = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          seen.disconnect();
          check();
        }
      });
      seen.observe(box);
    } else check();
    return box;
  }

  // One alert, drawn as a card
  function alertCard(n) {
    // The card (with room for its delete button)
    const card = el("article", "card has-delete");
    // The delete button in the corner
    const remove = el("button", "card-delete", "×");
    // Labelled for screen readers
    Object.assign(remove, { type: "button", title: "Delete this alert" });
    remove.setAttribute("aria-label", "Delete this alert");
    // Delete it when tapped
    remove.addEventListener("click", () => deleteAlert(n.id));
    // What it's about, as a coloured label ("Booking", "Nova Quest", "Test"...)
    const kind = n.kind || "other";
    card.classList.add("kind-" + kind);
    // The top: the title
    const top = el("div", "card-top");
    top.append(el("h3", "card-title", n.title));
    // When it was sent: the exact moment (to the second) and how long ago
    const exact = el("p", "alert-when", exactTime(n.created_at) + " · " + ago(n.created_at));
    // Then every detail (coloured), and how many phones it reached
    card.append(remove, el("span", "alert-kind " + kind, KIND_LABELS[kind] || "Alert"), top, exact, richDetails(n.body), el("p", "card-foot", `Alert #${n.id} · delivered to ${n.phones} ${n.phones === 1 ? "phone" : "phones"}`));
    // A booking in Acuity: check it with Acuity itself, so a real booking can't be mistaken for a test or a fake
    if (kind === "booking" && n.appointmentId) card.insertBefore(verifyPanel(n.appointmentId), exact.nextSibling);
    // A test: say plainly that it isn't a real booking
    if (kind === "test") card.insertBefore(el("p", "verify unknown", "A test notification: not a real booking or enquiry."), exact.nextSibling);
    // The latest from Acuity's email about this booking (if one has come through)
    if (n.email) card.appendChild(emailPanel(n.email));
    // A row of buttons
    const actions = el("div", "actions");
    // Alerts from Nova Agent, Nova Quest and Nova Mission: nothing to open
    const nova = novaSource(n.title);
    if (nova) {
      // Mark the card with its colour
      card.classList.add("nova-alert", nova.key);
      // No buttons: the card is the whole message
      return card;
    }
    // Enquiry alerts open the Enquiries tab; booking alerts open Acuity
    const open = el(n.url.startsWith("/app/") ? "button" : "a", "btn small", n.url.startsWith("/app/") ? "Open enquiry" : /acuityscheduling/.test(n.url) ? "Open in Acuity" : "Open in Google Calendar");
    // An enquiry: switch tabs when tapped
    if (n.url.startsWith("/app/")) open.addEventListener("click", () => show("enquiries"));
    // A booking: a link to Acuity, opened outside the app
    else Object.assign(open, { href: n.url, target: "_blank", rel: "noopener" });
    // Add it to the row
    actions.appendChild(open);
    // The customer's email, if we know it: an Email button
    if (n.contact.email) {
      // The button
      const email = el("a", "btn small ghost", "Email");
      // Opens a new email to them
      email.href = "mailto:" + encodeURIComponent(n.contact.email);
      // Add it to the row
      actions.appendChild(email);
    }
    // Their phone number, if we know it: a Call button
    if (n.contact.phone) {
      // The button
      const call = el("a", "btn small ghost", "Call");
      // Rings the number (digits and + only)
      call.href = "tel:" + n.contact.phone.replace(/[^0-9+]/g, "");
      // Add it to the row
      actions.appendChild(call);
    }
    // The email in Gmail, if we know where it is
    if (n.email && n.email.gmail) {
      // The button
      const gmail = el("a", "btn small ghost", "Open in Gmail");
      // Opens the email (outside the app)
      Object.assign(gmail, { href: n.email.gmail, target: "_blank", rel: "noopener" });
      // Add it to the row
      actions.appendChild(gmail);
    }
    // Put the buttons on the card
    card.appendChild(actions);
    // Hand the card back
    return card;
  }

  // The "From Acuity" box on a booking alert (its calendar or its email)
  function emailPanel(email) {
    // The box
    const box = el("div", "email-panel");
    // What kind of email it was, in plain words
    const kind = { scheduled: "booking", rescheduled: "move", canceled: "cancellation" }[email.kind] || "update";
    // Its heading: where the details came from, and when
    const head = email.source === "booking" ? "Booking now" : email.source === "calendar" ? "From Acuity's calendar" : "From Acuity's " + kind + " email";
    box.appendChild(el("p", "email-head", head + " · " + when(email.at)));
    // Every detail, unless the alert's own text above already shows exactly the same
    if (!email.same) box.appendChild(richDetails(email.lines.join("\n")));
    // Hand the box back
    return box;
  }

  // Delete one alert
  async function deleteAlert(id) {
    // Try it
    try {
      // Ask the Worker to delete it
      await api("notifications/delete", { body: { id } });
      // Let them know
      toast("Alert deleted");
      // Show the list without it
      loadAlerts();
    } catch (err) {
      // Something went wrong
      if (err.message !== "signed out") toast(err.message);
    }
  }

  // Delete every alert (after checking)
  async function deleteAllAlerts() {
    // Nothing to delete
    if (!lastAlerts.length) return toast("No alerts to delete");
    // Make sure
    if (!confirm("Delete all " + lastAlerts.length + " alerts?")) return;
    // Try it
    try {
      // Ask the Worker to delete them all
      await api("notifications/delete", { body: { all: true } });
      // Let them know
      toast("All alerts deleted");
      // Show the empty list
      loadAlerts();
    } catch (err) {
      // Something went wrong
      if (err.message !== "signed out") toast(err.message);
    }
  }

  // "Delete all" button
  $("alerts-clear").addEventListener("click", deleteAllAlerts);

  // Show the auto-delete switch as it's set (days = 0 means off)
  function showAutoDelete(days, choices) {
    // The day choices, filled in once
    const select = $("auto-delete-days");
    // Not filled in yet: add one option per choice
    if (!select.options.length) {
      select.replaceChildren(
        ...choices.map((d) => {
          // "1 day", "7 days"
          const option = el("option", "", d + (d === 1 ? " day" : " days"));
          // Its number
          option.value = d;
          // Hand it back
          return option;
        })
      );
      // Default choice when the switch is first turned on: 7 days
      select.value = "7";
    }
    // The switch: on or off
    $("auto-delete").checked = days > 0;
    // When it's on, show the chosen number of days
    if (days > 0) select.value = String(days);
    // The day choice only matters when the switch is on
    select.disabled = !(days > 0);
  }

  // Save the auto-delete setting (0 = off)
  async function saveAutoDelete(days) {
    // Try it
    try {
      // Tell the Worker
      await api("notifications/settings", { body: { days } });
      // Let them know
      toast(days ? "Alerts delete themselves after " + days + (days === 1 ? " day" : " days") : "Alerts are kept (90 days)");
      // Show the list as it is now
      loadAlerts();
    } catch (err) {
      // Something went wrong
      if (err.message !== "signed out") toast(err.message);
    }
  }

  // Flipping the switch
  $("auto-delete").addEventListener("change", () => saveAutoDelete($("auto-delete").checked ? Number($("auto-delete-days").value) : 0));
  // Choosing a different number of days (only while the switch is on)
  $("auto-delete-days").addEventListener("change", () => $("auto-delete").checked && saveAutoDelete(Number($("auto-delete-days").value)));

  // ===== Ask NovaBot =====

  function addBubble(text, me) {
    const bubble = el("div", "bubble" + (me ? " me" : ""));
    linkify(bubble, text);
    $("bot-messages").appendChild(bubble);
    bubble.scrollIntoView({ block: "end", behavior: "smooth" });
    return bubble;
  }

  function fitInput() {
    const box = $("bot-input");
    box.style.height = "auto";
    box.style.height = box.scrollHeight + 2 + "px";
  }

  // Which assistant the tab talks to: "nova" (knows the studio's bookings,
  // enquiries and alerts) or "customer" (the website's NovaBot, for testing)
  let botMode = "nova";

  // Switching between them starts a new chat
  document.querySelectorAll("[data-mode]").forEach((chip) =>
    chip.addEventListener("click", () => {
      // Remember the choice
      botMode = chip.dataset.mode;
      // Light up the chosen chip
      document.querySelectorAll("[data-mode]").forEach((c) => c.classList.toggle("active", c === chip));
      // Explain what this one does
      $("bot-hint").textContent =
        botMode === "nova"
          ? 'Ask about your bookings, enquiries and alerts: "What time is Eric\'s session?", "Any new enquiries?". These chats aren\'t saved.'
          : "The same NovaBot customers see on the website. Try a customer question, or ask for a booking link. These chats aren't saved.";
      // Start a fresh chat
      $("bot-clear").click();
    })
  );

  async function askNovaBot() {
    const box = $("bot-input");
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    fitInput();
    addBubble(text, true);
    botHistory.push({ role: "user", content: text });
    const typing = addBubble((botMode === "nova" ? "Nova" : "NovaBot") + " is typing…", false);
    typing.classList.add("typing");
    try {
      // Nova answers from the studio's data; NovaBot as it would for a customer
      const reply =
        botMode === "nova"
          ? (await api("ask", { body: { question: text, history: botHistory.slice(0, -1) } })).answer
          : (await api("chat", { body: { messages: botHistory } })).reply;
      typing.remove();
      addBubble(reply, false);
      botHistory.push({ role: "assistant", content: reply });
    } catch (err) {
      typing.remove();
      botHistory.pop();
      if (err.message !== "signed out") addBubble("Couldn't reach NovaBot: " + err.message, false);
    }
  }

  $("bot-form").addEventListener("submit", (e) => {
    e.preventDefault();
    askNovaBot();
  });
  $("bot-input").addEventListener("input", fitInput);
  $("bot-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      askNovaBot();
    }
  });
  $("bot-clear").addEventListener("click", () => {
    botHistory.length = 0;
    $("bot-messages").replaceChildren();
    $("bot-input").focus();
  });

  // ===== Notifications =====
  // Like giving the post office your address once: the phone gets a delivery
  // address from Apple, Nova Hub hands it to the Worker, and from then on the
  // Worker can post notifications to it, even when Nova Hub is closed.

  // Can this browser do notifications at all? (needs all three of these)
  const canNotify = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  // Is this an iPhone or iPad?
  const isIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  // Was Nova Hub opened from the Home Screen icon (rather than a Safari tab)?
  const fromHomeScreen = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

  // Install the doorman (sw.js) as soon as the app opens, so it's ready when needed
  if (canNotify) {
    navigator.serviceWorker
      .register("/app/sw.js", { scope: "/app/", updateViaCache: "none" })
      // Look for a newer doorman every time Nova Hub opens (and when it comes back to the front)
      .then((reg) => {
        reg.update().catch(() => {});
        document.addEventListener("visibilitychange", () => !document.hidden && reg.update().catch(() => {}));
      })
      .catch(() => {});
  }

  // ===== Pings =====
  // When a notification arrives while Nova Hub is open, it rings out with a
  // bright ping (a different one for each kind) and drops a banner from the top.

  // The sound maker (made on the first tap, because phones only allow sound after a tap)
  let sound = null;
  // Make it (or wake it up) on the first tap anywhere
  function wakeSound() {
    // Try it, ignoring phones that can't
    try {
      // Make it the first time
      if (!sound) sound = new (window.AudioContext || window.webkitAudioContext)();
      // Wake it if the phone put it to sleep
      if (sound.state === "suspended") sound.resume();
    } catch (err) {}
  }
  // Listen for that first tap (and later ones, in case the phone sends it back to sleep)
  ["pointerdown", "touchstart", "keydown"].forEach((type) => document.addEventListener(type, wakeSound, { passive: true }));

  // The notes for each kind of ping (in hertz), played one after another
  const PINGS = {
    // A quest is starting or it's time to leave: two bright rising notes
    starting: [1318.5, 1975.5],
    leave: [1174.7, 1568, 2093],
    // A quick repeat: one short, bright tick
    pulse: [2093],
    // A check-in: a quick double ping, twice
    checkin: [1760, 1760, 2349.3, 2349.3],
    // A mission: a sparkling run up
    mission: [1046.5, 1318.5, 1568, 2093, 2637],
    // Nova Agent: one clear, lower bell
    agent: [880, 1318.5],
  };

  // Play a ping (bright bell-like notes, each with a shimmer an octave up)
  function ping(kind) {
    // Wake the sound maker if it's allowed
    wakeSound();
    // No sound on this phone: just buzz (where phones allow it)
    if (!sound || sound.state !== "running") return navigator.vibrate && navigator.vibrate([200, 100, 200]);
    // The notes to play
    const notes = PINGS[kind] || PINGS.starting;
    // Now, in the sound maker's clock
    const t0 = sound.currentTime + 0.02;
    // Play each note a little after the last
    notes.forEach((freq, i) => {
      // When this note starts
      const t = t0 + i * 0.11;
      // The note and its shimmer
      [[freq, 0.22, "sine"], [freq * 2, 0.06, "triangle"]].forEach(([f, loud, wave]) => {
        // The tone
        const osc = sound.createOscillator();
        // Its volume
        const gain = sound.createGain();
        // Set the tone
        osc.type = wave;
        osc.frequency.value = f;
        // A sharp strike that rings away, like a bell
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(loud, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        // Wire it up and play it
        osc.connect(gain).connect(sound.destination);
        osc.start(t);
        osc.stop(t + 1);
      });
    });
    // A buzz too, on phones that can
    if (navigator.vibrate) navigator.vibrate([180, 80, 180]);
  }

  // Drop a banner from the top of the screen
  function banner(data) {
    // A newer one about the same thing replaces the old banner (quick repeats don't stack up)
    if (data.tag) document.querySelectorAll(".ping-banner").forEach((b) => b.dataset.tag === data.tag && b.remove());
    // The banner
    const box = el("div", "ping-banner " + (data.source || "agent"));
    // Remember what it's about
    box.dataset.tag = data.tag || "";
    // Its title and text
    box.append(el("strong", "", data.title || "Nova Hub"), el("p", "", data.body || ""));
    // Tapping it opens the Alerts tab
    box.addEventListener("click", () => {
      box.remove();
      show("alerts");
    });
    // Put it on the page
    document.body.appendChild(box);
    // Check-ins and problems stay a while; the rest go after 7 seconds
    setTimeout(() => box.classList.add("going"), data.urgent ? 30000 : 7000);
    setTimeout(() => box.remove(), data.urgent ? 30600 : 7600);
  }

  // Messages from the doorman
  if (canNotify) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      // A notification just arrived: ping, show the banner and refresh the Alerts
      if (event.data?.type === "nova-push") {
        ping(event.data.kind || event.data.source);
        banner(event.data);
        loadAlerts();
        if (event.data.source === "quest" || event.data.source === "mission") loadQuests();
      }
      // A notification was tapped: show the Alerts tab
      if (event.data?.type === "nova-open") show(String(event.data.url).includes("#nova") ? "alerts" : currentView);
    });
  }

  // Opening Nova Hub clears the dot on its Home Screen icon
  function clearIconDot() {
    // Only where the phone supports it
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  }
  // Now, and every time Nova Hub comes back to the front
  clearIconDot();
  document.addEventListener("visibilitychange", () => !document.hidden && clearIconDot());

  // Turn the public key (text) into the raw bytes the phone wants
  function keyBytes(text) {
    // Put back the padding and characters that the web-safe version leaves out
    const base64 = (text + "===".slice((text.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    // Decode it into raw bytes
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  // This phone's current notification address, if it has one
  async function currentAddress() {
    // No notifications on this browser: no address
    if (!canNotify) return null;
    // Wait until the doorman is installed
    const reg = await navigator.serviceWorker.ready;
    // Ask for the address the phone already has (or nothing)
    return reg.pushManager.getSubscription();
  }

  // Show the right message and buttons in the notifications panel
  async function updateNotifyPanel() {
    // Does this phone already have an address?
    const address = await currentAddress().catch(() => null);
    // Light the bell up if notifications are on
    $("bell").classList.toggle("on", Boolean(address));
    // The message under the title
    let status = "Get a notification here for new enquiries and bookings.";
    // iPhone in a Safari tab: it has to be opened from the Home Screen first
    if (!canNotify && isIPhone && !fromHomeScreen) {
      status = "On iPhone, notifications only work when Nova Hub is opened from its Home Screen icon. In Safari, tap Share, then Add to Home Screen, then open Nova Hub from there.";
    }
    // Any other browser that can't do it
    else if (!canNotify) status = "This browser can't show notifications.";
    // He said no to the iPhone's question earlier: only Settings can change that now
    else if (Notification.permission === "denied") status = "Notifications are blocked for Nova Hub. Turn them on in the iPhone's Settings, then Notifications, then Nova Hub.";
    // Already on
    else if (address) status = "Notifications are on for this phone.";
    // Put the message in the panel
    $("notify-status").textContent = status;
    // Show "Turn on" only when it can be turned on and isn't already
    $("notify-on").hidden = !canNotify || Boolean(address) || Notification.permission === "denied";
    // Show "Send a test" and "Turn off" only when it's on
    $("notify-test").hidden = !address;
    $("notify-off").hidden = !address;
  }

  // Open the panel when the bell is tapped
  $("bell").addEventListener("click", () => {
    // Show the panel
    $("notify-sheet").hidden = false;
    // Fill it in
    updateNotifyPanel();
  });
  // Close it with the Close button
  $("notify-close").addEventListener("click", () => ($("notify-sheet").hidden = true));
  // Or by tapping outside it
  $("notify-sheet").addEventListener("click", (e) => {
    // Only when the tap was on the dark background, not the panel itself
    if (e.target === $("notify-sheet")) $("notify-sheet").hidden = true;
  });

  // "Turn on notifications" (the iPhone only allows the question after a tap like this)
  $("notify-on").addEventListener("click", async () => {
    // Stop double taps while it works
    $("notify-on").disabled = true;
    // Try it, and report anything that goes wrong
    try {
      // Ask the iPhone's "Allow notifications?" question first, straight from the tap
      const answer = await Notification.requestPermission();
      // He didn't tap Allow: update the panel and stop
      if (answer !== "granted") return updateNotifyPanel();
      // Get our public key from the Worker (it proves the notifications are ours)
      const { publicKey } = await api("push/key");
      // The server hasn't been given its keys yet
      if (!publicKey) throw new Error("Notifications aren't set up on the server yet.");
      // Wait until the doorman is installed
      const reg = await navigator.serviceWorker.ready;
      // Ask Apple for this phone's delivery address
      const address = await reg.pushManager.subscribe({
        // iPhone rule: every notification must be shown to him
        userVisibleOnly: true,
        // Our public key, so only our Worker can send to this address
        applicationServerKey: keyBytes(publicKey),
      });
      // Hand the address to the Worker to keep
      await api("push/subscribe", { body: { subscription: address.toJSON() } });
      // Let him know it worked
      toast("Notifications are on");
    } catch (err) {
      // Show what went wrong in the panel
      $("notify-status").textContent = "Couldn't turn notifications on: " + err.message;
      // Let him try again
      $("notify-on").disabled = false;
      // Don't overwrite the error message below
      return;
    }
    // Let the button work again next time
    $("notify-on").disabled = false;
    // Show the new state
    updateNotifyPanel();
  });

  // "Send a test": the Worker sends a notification to every signed-up phone
  $("notify-test").addEventListener("click", async () => {
    // Try it
    try {
      // Ask the Worker to send it, and hear how many phones it reached
      const { delivered } = await api("push/test", { body: {} });
      // Report back
      toast(delivered ? "Test sent to " + delivered + (delivered === 1 ? " phone" : " phones") : "No phones got it. Try turning notifications off and on.");
    } catch (err) {
      // Something went wrong
      toast(err.message);
    }
  });

  // "Turn off on this phone"
  $("notify-off").addEventListener("click", async () => {
    // Find this phone's address
    const address = await currentAddress();
    // Only if it has one
    if (address) {
      // Ask the Worker to forget it (ignore problems: we still switch it off below)
      await api("push/unsubscribe", { body: { endpoint: address.endpoint } }).catch(() => {});
      // Tell Apple to cancel the address too
      await address.unsubscribe();
    }
    // Let him know
    toast("Notifications are off on this phone");
    // Show the new state
    updateNotifyPanel();
  });

  // ===== Voice commands =====
  // Tap the mic, say what to do, and Nova Hub does it. Like asking someone at
  // the front desk: the recording goes to the Worker, which writes down the
  // words (Whisper), and the app matches them to a command below. Anything
  // that isn't a command is asked to NovaBot instead.
  //
  // Hands-free ("Always listen"): while Nova Hub is open on screen, it keeps
  // listening and acts on anything that starts with "Nova" ("Nova, show
  // alerts"), so everyday conversation is ignored. iPhones only allow the
  // microphone while the app is open, so it pauses when you leave and starts
  // again when you come back.

  // Can this browser record sound?
  const canRecord = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  // The microphone while it's open: { stream, context, meter, samples } (or null)
  let mic = null;
  // The recording in progress (or null)
  let recorder = null;
  // Is hands-free switched on (remembered on this phone)?
  let handsFree = false;
  try {
    handsFree = localStorage.getItem("novahub-handsfree") === "on";
  } catch (err) {}
  // Is the hands-free loop running right now?
  let looping = false;
  // Hide the mic (and the switch) where recording isn't possible
  if (!canRecord) $("voice").hidden = true;

  // The mic button: with hands-free on, it switches hands-free off;
  // otherwise it listens once (or stops listening)
  $("voice").addEventListener("click", () => {
    // Hands-free is on: turn it off
    if (handsFree) return setHandsFree(false);
    // Listening once already: stop and use what was said
    if (recorder) return stopRecording();
    // Listen once
    listenOnce();
  });
  // The "Done" button: stop listening now
  $("voice-stop").addEventListener("click", () => {
    // Hands-free keeps listening; just close the panel
    if (handsFree) {
      window.speechSynthesis?.cancel();
      return closeVoice();
    }
    // Listening once: stop and use what was said; otherwise close
    recorder ? stopRecording() : closeVoice();
  });
  // The "Always listen" switch in the voice panel
  $("handsfree-switch").addEventListener("change", () => setHandsFree($("handsfree-switch").checked));
  // The "Stop" button on the listening bar
  $("listening-off").addEventListener("click", () => setHandsFree(false));

  // Show the listening panel with a message
  function voiceStatus(text, thinking) {
    // Show the panel
    $("voice-sheet").hidden = false;
    // Faster rings while working out the words
    $("voice-sheet").classList.toggle("thinking", Boolean(thinking));
    // The message
    $("voice-status").textContent = text;
    // No answer showing yet
    $("voice-answer").hidden = true;
    // The switch shows whether hands-free is on
    $("handsfree-switch").checked = handsFree;
  }

  // Hide the listening panel
  function closeVoice() {
    // Hide it
    $("voice-sheet").hidden = true;
    // The mic stops glowing (unless hands-free is on)
    $("voice").classList.toggle("on", handsFree);
  }

  // The bar under the header while hands-free is on
  function listeningBar(text) {
    // Show it, or hide it when there's no text
    $("listening-bar").hidden = !text;
    // The message
    if (text) $("listening-text").textContent = text;
  }

  // Turn hands-free on or off (and remember it on this phone)
  function setHandsFree(on) {
    // Remember the choice
    handsFree = on;
    try {
      localStorage.setItem("novahub-handsfree", on ? "on" : "off");
    } catch (err) {}
    // The mic glows while it's on
    $("voice").classList.toggle("on", on);
    // Any single listen in progress stops (and is thrown away)
    cancelRecording();
    // Close the voice panel
    $("voice-sheet").hidden = true;
    // Start listening, or stop
    if (on) {
      toast("Always listening. Start with “Nova”");
      startHandsFree();
    } else {
      toast("Stopped listening");
      listeningBar("");
      closeMic();
    }
  }

  // Open the microphone (and a volume meter, to hear when someone's talking)
  async function openMic() {
    // Already open
    if (mic) return mic;
    // Ask for the microphone: clear sound, without echo
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    // Something to measure the volume with
    const context = new (window.AudioContext || window.webkitAudioContext)();
    // iPhones start it paused; try to start it (it may need a tap, see below)
    try {
      await context.resume();
    } catch (err) {}
    // The volume meter
    const meter = context.createAnalyser();
    // Its size
    meter.fftSize = 1024;
    // Connect the microphone to it
    context.createMediaStreamSource(stream).connect(meter);
    // Keep it all together
    mic = { stream, context, meter, samples: new Float32Array(meter.fftSize) };
    // Hand it back
    return mic;
  }

  // Close the microphone (the iPhone's orange dot goes away)
  function closeMic() {
    // Nothing open
    if (!mic) return;
    // Stop any recording
    cancelRecording();
    // Turn the microphone off
    mic.stream.getTracks().forEach((t) => t.stop());
    // Close the volume meter
    mic.context.close().catch(() => {});
    // Closed
    mic = null;
  }

  // Is someone talking right now?
  function talking() {
    // Read the volume
    mic.meter.getFloatTimeDomainData(mic.samples);
    // How loud it is (average power)
    let sum = 0;
    for (const x of mic.samples) sum += x * x;
    // Loud enough to be speech?
    return Math.sqrt(sum / mic.samples.length) > 0.02;
  }

  // Record one thing said. Resolves with a WAV recording, or null if nothing
  // was said within `waitMs` (or the recording was cancelled).
  function recordOnce(waitMs) {
    return new Promise((resolve) => {
      // Record from the open microphone
      const rec = new MediaRecorder(mic.stream);
      // The pieces of the recording
      const chunks = [];
      // Keep each piece
      rec.addEventListener("dataavailable", (e) => chunks.push(e.data));
      // When it started, whether they've spoken yet, and when they last made a sound
      const started = Date.now();
      let spoke = false;
      let lastSound = Date.now();
      // Check the volume ten times a second
      const timer = setInterval(() => {
        // Someone's talking
        if (talking()) {
          spoke = true;
          lastSound = Date.now();
        }
        // Stop after a 1.2-second pause, nothing said for a while, or 15 seconds in all
        if ((spoke && Date.now() - lastSound > 1200) || (!spoke && Date.now() - started > waitMs) || Date.now() - started > 15000) {
          if (rec.state === "recording") rec.stop();
        }
      }, 100);
      // When it stops: hand back the recording (or nothing)
      rec.addEventListener("stop", async () => {
        // Stop checking the volume
        clearInterval(timer);
        // No longer recording (unless a newer recording has already started)
        if (recorder === rec) recorder = null;
        // Cancelled, or nothing said
        if (rec.cancelled || !spoke || !chunks.length) return resolve(null);
        // Turn it into a WAV file the Worker can always read
        resolve(await toWav(new Blob(chunks, { type: rec.mimeType })).catch(() => null));
      });
      // Start
      recorder = rec;
      rec.start();
    });
  }

  // Stop recording and use what was said
  function stopRecording() {
    // Only if it's recording
    if (recorder && recorder.state === "recording") recorder.stop();
  }

  // Stop recording and throw it away
  function cancelRecording() {
    // Mark it as cancelled, then stop
    if (recorder) recorder.cancelled = true;
    stopRecording();
  }

  // Send a recording to the Worker to be written down
  async function transcribe(wav) {
    // Send it
    const res = await fetch("/app/api/voice", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, credentials: "same-origin" });
    // The answer
    const data = await res.json().catch(() => ({}));
    // Signed out
    if (res.status === 401) {
      showLogin();
      throw new Error("signed out");
    }
    // Didn't work
    if (!res.ok) throw new Error(data.error || "Couldn't make that out. Try again.");
    // The words
    return data.text || "";
  }

  // Listen once (the mic button, when hands-free is off)
  async function listenOnce() {
    // Open the microphone
    try {
      await openMic();
    } catch (err) {
      return toast("Nova Hub can't use the microphone. Allow it in Settings.");
    }
    // The mic glows, and the panel shows
    $("voice").classList.add("on");
    voiceStatus("Listening…");
    // Record what's said (up to 7 seconds to start talking)
    const wav = await recordOnce(7000);
    // Hands-free was switched on meanwhile: it has the microphone now
    if (handsFree) return;
    // Done with the microphone
    closeMic();
    // Nothing said
    if (!wav) return closeVoice();
    // Working on it
    voiceStatus("Working out what you said…", true);
    try {
      // Write it down
      const text = await transcribe(wav);
      // Close the panel
      closeVoice();
      // Do what was asked
      if (text) await runCommand(text);
    } catch (err) {
      // Show the problem, then close
      if (err.message === "signed out") return closeVoice();
      voiceStatus(err.message);
      setTimeout(closeVoice, 2200);
    }
  }

  // What was said after "Nova" (null if it didn't start with "Nova").
  // Whisper sometimes hears "Nova" as "Noah", "Nava" or "Nover".
  function afterWakeWord(text) {
    // "Nova, show alerts", "Hey Nova show alerts", "Nova Hub, call Eric"
    const m = String(text).match(/^\W*(?:(?:hey|hi|ok|okay)\W+)?(?:nova(?:\s*hub)?|novah|noah|nava|nover|no va)\b\W*(.*)$/i);
    // The command (maybe empty), or null
    return m ? m[1].trim() : null;
  }

  // Wait for one tap anywhere (iPhones need a tap before the app can hear)
  function waitForTap() {
    return new Promise((resolve) => document.addEventListener("pointerdown", resolve, { once: true }));
  }

  // Hands-free: keep listening while Nova Hub is open and on screen
  async function startHandsFree() {
    // Already running, switched off, signed out, or not on screen
    if (looping || !handsFree || !canRecord || $("app").hidden || document.hidden) return;
    // Running now
    looping = true;
    // Open the microphone (if the iPhone wants a tap first, wait for one)
    try {
      await openMic();
    } catch (err) {
      // Ask for a tap, then try again
      listeningBar("Tap anywhere to start listening");
      await waitForTap();
      try {
        await openMic();
      } catch (err2) {
        // Still no: the microphone is blocked
        listeningBar("");
        looping = false;
        return toast("Nova Hub can't use the microphone. Allow it in Settings.");
      }
    }
    // The volume meter is paused until a tap (iPhone rule): wait for one
    if (mic.context.state !== "running") {
      listeningBar("Tap anywhere to start listening");
      await waitForTap();
      await mic.context.resume().catch(() => {});
    }
    // Keep going while hands-free is on and the app is on screen
    while (handsFree && !document.hidden && !$("app").hidden && mic) {
      // Ready
      listeningBar("Listening… say “Nova, …”");
      // Wait for someone to say something (up to 10 seconds, then start again)
      const wav = await recordOnce(10000);
      // Switched off or left meanwhile
      if (!handsFree || document.hidden || !mic) break;
      // Nothing said: listen again
      if (!wav) continue;
      // Working on it
      listeningBar("Working out what you said…");
      // Write it down
      let text = "";
      try {
        text = await transcribe(wav);
      } catch (err) {
        // Signed out: stop; anything else: carry on listening
        if (err.message === "signed out") break;
        continue;
      }
      // The command after "Nova" (null: not meant for Nova Hub, so ignore it)
      const command = afterWakeWord(text);
      // Not for us
      if (command === null) continue;
      // Just "Nova": nothing to do yet
      if (!command) {
        toast("Yes? Say what to do after “Nova”");
        continue;
      }
      // Do it
      await runCommand(command);
    }
    // Stopped: close the microphone and hide the bar
    closeMic();
    listeningBar("");
    looping = false;
    // Came straight back while it was stopping: start again
    if (handsFree && !document.hidden && !$("app").hidden) setTimeout(startHandsFree, 300);
  }

  // Leaving the app: stop listening. Coming back: start again.
  document.addEventListener("visibilitychange", () => {
    // Left: stop recording (the loop sees it and closes the microphone)
    if (document.hidden) cancelRecording();
    // Back: start again if hands-free is on
    else startHandsFree();
  });

  // Turn any recording into a small 16 kHz mono WAV file (iPhones record in a format Whisper can't always read)
  async function toWav(blob) {
    // Decode the recording
    const decoder = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
    decoder.close();
    // Re-play it at 16,000 samples a second, in mono
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    // The sound as numbers
    const pcm = (await offline.startRendering()).getChannelData(0);
    // Write the WAV file: a 44-byte header, then the sound
    const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const text = (at, str) => [...str].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    pcm.forEach((x, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
    // Hand it back
    return new Blob([view], { type: "audio/wav" });
  }

  // The number of days said ("7 days", "seven days", "a week"), or 0
  function daysSaid(t) {
    // Digits ("7 days")
    const digits = t.match(/\b(\d{1,2})\b/);
    if (digits) return Number(digits[1]);
    // Words
    if (/\b(a|one) day\b/.test(t)) return 1;
    if (/\bthree days\b/.test(t)) return 3;
    if (/\b(a|one) week\b|\bseven days\b/.test(t)) return 7;
    if (/\bfortnight\b|\btwo weeks\b|\bfourteen days\b/.test(t)) return 14;
    if (/\b(a|one) month\b|\bthirty days\b/.test(t)) return 30;
    // None
    return 0;
  }

  // Find a customer by the name they said, in the alerts and enquiries
  async function findPerson(spoken) {
    // Get the latest of both
    try {
      lastAlerts = (await api("notifications")).notifications;
      lastEnquiries = (await api("enquiries?show=all")).enquiries;
    } catch (err) {}
    // Everyone we know, with how to reach them (newest first)
    const people = [
      ...lastAlerts.map((a) => a.contact).filter((c) => c && c.name),
      ...lastEnquiries.map((q) => ({ name: q.name, email: q.email, phone: q.phone, enquiry: q })),
    ];
    // The words they said
    const words = spoken.toLowerCase().split(/[^a-z']+/);
    // The person whose name shares the most words with what was said
    let best = null;
    let bestScore = 0;
    people.forEach((p) => {
      // How many parts of their name were said
      const score = p.name.toLowerCase().split(/\s+/).filter((part) => part.length > 1 && words.includes(part)).length;
      // Better than anyone so far (ties go to the newest)
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    });
    // Them, or nobody
    return best;
  }

  // Do what was said
  async function runCommand(said) {
    // Show what was heard
    toast("“" + said + "”");
    // Lower case, without punctuation, for matching
    const t = said.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
    // A number of days, if one was said
    const n = daysSaid(t);
    // Any open answer panel closes for the next command
    if (!$("voice-sheet").hidden) closeVoice();

    // A question about bookings, enquiries or alerts: Nova answers it (and says it out loud)
    if (/^(what|whats|what's|when|who|whose|where|which|how|is|are|was|were|does|do|did|has|have|had|can|could|tell|give|any|list|find|check)\b/.test(t)) return askNova(said);

    // Auto-delete: "auto delete off", "delete alerts after 7 days"
    if (/auto ?delete|delete (my |the )?alerts after|keep alerts/.test(t)) {
      // Off, or a number of days
      if (/\b(off|stop|never|forever)\b/.test(t)) return saveAutoDelete(0);
      // One of the choices
      if ([1, 3, 7, 14, 30].includes(n)) return saveAutoDelete(n);
      // Not a choice
      return toast("Say 1, 3, 7, 14 or 30 days, or “auto delete off”");
    }
    // "Delete all alerts", "clear alerts"
    if (/\b(delete|clear|remove|wipe)\b.*\b(alerts?|notifications?)\b/.test(t) && !/\b(latest|last|newest|top|first)\b/.test(t)) return show("alerts"), deleteAllAlerts();
    // "Delete the latest alert"
    if (/\b(delete|remove)\b.*\b(latest|last|newest|top|first)\b/.test(t)) {
      // The newest alert
      const latest = (await api("notifications")).notifications[0];
      // None
      if (!latest) return toast("No alerts to delete");
      // Check first
      if (confirm("Delete the alert “" + latest.title + "”?")) deleteAlert(latest.id);
      // Done
      return show("alerts");
    }
    // "Call Eric", "ring Fanny Winters"
    let m = t.match(/^(call|ring|phone)\b (.+)/);
    if (m) {
      // Who
      const person = await findPerson(m[2]);
      // Nobody with that name, or no number
      if (!person || !person.phone) return toast(person ? person.name + " has no phone number" : "Couldn't find “" + m[2] + "”");
      // Check, then ring them
      if (confirm("Call " + person.name + " on " + person.phone + "?")) location.href = "tel:" + person.phone.replace(/[^0-9+]/g, "");
      return;
    }
    // "Email Eric"
    m = t.match(/^(email|e mail|mail)\b (.+)/);
    if (m) {
      // Who
      const person = await findPerson(m[2]);
      // Nobody with that name, or no email
      if (!person || !person.email) return toast(person ? person.name + " has no email" : "Couldn't find “" + m[2] + "”");
      // Open a new email to them
      location.href = "mailto:" + encodeURIComponent(person.email);
      return;
    }
    // "Mark Jordan done"
    m = t.match(/\bmark (.+?) (as )?(done|finished|complete)\b/);
    if (m) {
      // Whose enquiry
      const person = await findPerson(m[1]);
      // Not an enquiry
      if (!person || !person.enquiry) return toast("Couldn't find an enquiry from “" + m[1] + "”");
      // Mark it done
      await api("enquiries/status", { body: { id: person.enquiry.id, status: "done" } });
      // Let them know, and show the list
      toast(person.name + "'s enquiry marked done");
      return show("enquiries");
    }
    // "Send a test notification"
    if (/\btest\b.*\bnotification/.test(t)) return $("notify-test").click();
    // "Sign out"
    if (/\b(sign|log) ?out\b/.test(t)) return $("logout").click();
    // "Refresh"
    if (/^(refresh|reload|update)\b/.test(t)) return $("refresh").click();
    // Sections: "show alerts", "new enquiries", "chats", "open NovaBot"
    if (/\b(calendar|diary|schedule|bookings?|sessions?)\b/.test(t) && !/^ask\b/.test(t)) return show("calendar");
    if (/\b(alerts?|notifications?)\b/.test(t) && !/^ask\b/.test(t)) return show("alerts");
    if (/\b(en|in)quir/.test(t) && !/^ask\b/.test(t)) {
      // "All enquiries" or just the new ones
      enquiryFilter = /\ball\b/.test(t) ? "all" : "new";
      document.querySelectorAll("[data-show]").forEach((c) => c.classList.toggle("active", c.dataset.show === enquiryFilter));
      return show("enquiries");
    }
    if (/\b(chats?|conversations?)\b/.test(t)) return show("chats");
    // "Ask NovaBot …": the customer NovaBot, in its tab
    if (/^ask (nova ?bot)\b/.test(t)) {
      // The question without "ask NovaBot"
      const question = said.replace(/^\s*ask\s+nova ?bot[,:]?\s*/i, "").trim();
      // Switch the tab to the customer NovaBot and open it
      document.querySelector('[data-mode="customer"]').click();
      show("bot");
      // Ask it
      if (question) {
        $("bot-input").value = question;
        askNovaBot();
      }
      return;
    }
    // Anything else: Nova answers it from the studio's data
    return askNova(said.replace(/^\s*ask\s+(nova\s*)?/i, ""));
  }

  // Nova's answers so far (for follow-up questions like "and his phone number?")
  const novaHistory = [];

  // Ask Nova a question, show the answer and say it out loud
  async function askNova(question) {
    // Show that it's thinking
    voiceStatus("Thinking…", true);
    try {
      // Ask the Worker
      const { answer } = await api("ask", { body: { question, history: novaHistory } });
      // Remember the question and answer (the last three of each)
      novaHistory.push({ role: "user", content: question }, { role: "assistant", content: answer });
      novaHistory.splice(0, Math.max(0, novaHistory.length - 6));
      // Show the question and the answer
      voiceStatus("“" + question + "”");
      $("voice-answer").textContent = answer;
      $("voice-answer").hidden = false;
      // Say it out loud (hands-free waits until it's finished, so it doesn't hear itself)
      await speak(answer);
    } catch (err) {
      // Signed out, or something went wrong
      if (err.message === "signed out") return closeVoice();
      voiceStatus(err.message);
    }
  }

  // Say something out loud (with a British voice, if the phone has one)
  function speak(text) {
    return new Promise((resolve) => {
      // This browser can't speak
      if (!("speechSynthesis" in window)) return resolve();
      // Stop anything already being said
      speechSynthesis.cancel();
      // What to say, without any formatting marks
      const words = new SpeechSynthesisUtterance(String(text).replace(/[*_#`]/g, ""));
      // British English
      words.lang = "en-GB";
      // A British voice, if there is one
      const voice = speechSynthesis.getVoices().find((v) => v.lang === "en-GB");
      if (voice) words.voice = voice;
      // Finished (or failed): carry on
      words.onend = words.onerror = () => resolve();
      // Say it
      speechSynthesis.speak(words);
      // Never wait more than 30 seconds
      setTimeout(resolve, 30000);
    });
  }

  // ===== Button ripples =====
  // A soft ring of light spreads from wherever a button is tapped

  document.addEventListener("pointerdown", (e) => {
    // The button (or chip, icon button, tab, calendar day) that was tapped
    const button = e.target.closest(".btn, .chip, .icon-btn, .tab, .cal-day, .card-delete");
    // Not a button, or the phone prefers less movement
    if (!button || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Where on the button it was tapped
    const box = button.getBoundingClientRect();
    // The ring
    const ring = el("span", "ripple");
    // Big enough to cover the whole button
    const size = Math.max(box.width, box.height) * 2;
    // Centred on the finger
    Object.assign(ring.style, { width: size + "px", height: size + "px", left: e.clientX - box.left - size / 2 + "px", top: e.clientY - box.top - size / 2 + "px" });
    // Add it, and remove it when it's faded
    button.appendChild(ring);
    setTimeout(() => ring.remove(), 650);
  });

  // ===== Start =====

  api("me")
    .then(showApp)
    .catch((err) => {
      if (err.message !== "signed out") showLogin();
    });
})();
