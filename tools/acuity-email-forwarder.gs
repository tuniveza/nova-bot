// Nova Hub: passes Acuity's booking emails to the Worker, so staff
// notifications include the customer's name, phone, email and form answers.
//
// Runs inside the Google account that receives Acuity's "New Appointment"
// emails, once a minute. It only reads emails from Acuity, and only sends
// them to the Novacane Worker.
//
// Set up (once): script.google.com → New project → paste this file → put the
// key in KEY below → Save → choose "setUp" at the top → Run → Allow.

// Where the emails go (the Novacane Worker)
var WORKER = "https://novacane-worker.novacane-studio.workers.dev/acuity/email";
// The secret key the Worker expects (the ACUITY_EMAIL_KEY secret)
var KEY = "PASTE-THE-KEY-HERE";

// Run this once: checks Acuity's emails every minute from now on
function setUp() {
  // Remove any older copy of the timer, so there's only ever one
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    // Delete it
    ScriptApp.deleteTrigger(trigger);
  });
  // Start a timer that runs sendAcuityEmails every minute
  ScriptApp.newTrigger("sendAcuityEmails").timeBased().everyMinutes(1).create();
  // Start from 24 hours ago, so today's bookings get their details too
  PropertiesService.getScriptProperties().setProperty("since", String(Date.now() - 24 * 60 * 60 * 1000));
  // And send those straight away, rather than waiting a minute
  sendAcuityEmails();
}

// Every minute: send any new emails from Acuity to the Worker
function sendAcuityEmails() {
  // The saved notes for this script
  var notes = PropertiesService.getScriptProperties();
  // The time of the newest email already sent (or 10 minutes ago, the first time)
  var since = Number(notes.getProperty("since") || Date.now() - 10 * 60 * 1000);
  // Recent emails from Acuity
  var threads = GmailApp.search("from:(acuityscheduling.com OR acuityscheduling-mail.com) newer_than:1d", 0, 30);
  // Every email in those conversations, oldest first
  var emails = [];
  // Go through each conversation
  threads.forEach(function (thread) {
    // Add its emails that are newer than the last one sent
    thread.getMessages().forEach(function (email) {
      // Only new ones
      if (email.getDate().getTime() > since) emails.push(email);
    });
  });
  // Oldest first
  emails.sort(function (a, b) {
    // Compare their times
    return a.getDate().getTime() - b.getDate().getTime();
  });
  // Send each one
  for (var i = 0; i < emails.length; i++) {
    // Hand it to the Worker
    var reply = UrlFetchApp.fetch(WORKER, {
      // Sending, not fetching
      method: "post",
      // As JSON
      contentType: "application/json",
      // With the secret key
      headers: { "X-Nova-Key": KEY },
      // The subject, the email itself, its plain-text version, and where to find it in Gmail
      payload: JSON.stringify({
        // The subject line
        subject: emails[i].getSubject(),
        // The email as Acuity sent it
        html: emails[i].getBody(),
        // Its plain-text version
        text: emails[i].getPlainBody(),
        // Gmail's number for it (for Nova Hub's "Open in Gmail" button)
        messageId: emails[i].getId(),
        // Which Gmail account it's in (so the button opens the right one)
        account: Session.getEffectiveUser().getEmail(),
      }),
      // Don't stop on an error: check the answer below instead
      muteHttpExceptions: true,
    });
    // The Worker didn't take it: stop, and try again next minute
    if (reply.getResponseCode() !== 200) return console.log("Worker said " + reply.getResponseCode() + ": " + reply.getContentText());
    // It did: remember this email as sent
    notes.setProperty("since", String(emails[i].getDate().getTime()));
  }
}

// Run this to check the set-up: shows which account the script runs as, and
// the Acuity emails it can see from the last 2 days
function check() {
  // The Google account this script reads
  console.log("Account: " + Session.getEffectiveUser().getEmail());
  // Acuity's emails from the last 2 days
  var threads = GmailApp.search("from:(acuityscheduling.com OR acuityscheduling-mail.com) newer_than:2d", 0, 10);
  // How many
  console.log("Acuity emails in the last 2 days: " + threads.length);
  // The subject line of each (the newest 10)
  threads.forEach(function (thread) {
    // When, and what it says
    console.log(thread.getLastMessageDate() + " | " + thread.getFirstMessageSubject());
  });
  // Whether the every-minute timer is on
  console.log("Timer on: " + (ScriptApp.getProjectTriggers().length > 0 ? "yes" : "no"));
  // The time the script will send emails from
  console.log("Sending emails newer than: " + new Date(Number(PropertiesService.getScriptProperties().getProperty("since") || 0)));
}
