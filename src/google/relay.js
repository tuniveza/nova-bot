// Portal's pictures and receipts when the studio PC is off: from the copies in Google Drive
//
// Portal shows social posts' pictures and videos (/social-media/<id>.<ext>) and receipts
// (/receipts/<id>) from the studio PC, through Nova Bot's link (src/agent-relay.js). When the PC
// answers "offline" and there's a copy in Drive (src/google/drive.js), the copy is shown instead,
// to the same signed-in staff only.

import { requireStaff } from "../portal/auth.js";
import { fileFromDrive } from "./drive.js";

const MEDIA = /^\/social-media\/([a-f0-9]{32})\.(jpg|png|webp|gif|mp4|mov)$/;
const RECEIPT = /^\/receipts\/(r-\d{8}-[a-f0-9]{10})$/;
const BOARD_FILE = /^\/board-files\/(b-\d{8}-[a-f0-9]{12})$/;
// What a Board's file may be shown with: only something to look at or listen to, never run
const BOARD_SAFE = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'";
const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime" };

export async function relayWithDrive(request, env, ctx, handleRelay) {
  const { pathname } = new URL(request.url);
  // A Board's pictures, videos and files: from their copy in Drive first (quick, any size, Range
  // works so videos start at once and can skip; no studio PC needed), else from the PC as before.
  // Each file's id never changes (a new file is a new id), so the browser may keep it a day.
  const board = request.method === "GET" ? pathname.match(BOARD_FILE) : null;
  if (board && (await requireStaff(request, env))) {
    const drive = await fileFromDrive(env, "board", board[1], request.headers.get("Range")).catch(() => null);
    if (drive) {
      const headers = new Headers({ "Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": BOARD_SAFE, "X-Nova-From": "google-drive" });
      headers.set("Content-Type", drive.headers.get("Content-Type") || "application/octet-stream");
      headers.set("Accept-Ranges", "bytes");
      for (const h of ["Content-Length", "Content-Range"]) if (drive.headers.get(h)) headers.set(h, drive.headers.get(h));
      return new Response(drive.body, { status: drive.status, headers });
    }
  }
  const media = request.method === "GET" ? pathname.match(MEDIA) : null;
  const receipt = request.method === "GET" ? pathname.match(RECEIPT) : null;
  const res = await handleRelay(request, env, ctx);
  if ((!media && !receipt) || res.status !== 503) return res;
  if (!(await requireStaff(request, env))) return res;
  const drive = await fileFromDrive(env, media ? "media" : "receipt", media ? media[1] : receipt[1], request.headers.get("Range")).catch(() => null);
  if (!drive) return res;
  const headers = new Headers({ "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "X-Nova-From": "google-drive" });
  headers.set("Content-Type", media ? TYPES[media[2]] : drive.headers.get("Content-Type") || "application/octet-stream");
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) if (drive.headers.get(h)) headers.set(h, drive.headers.get(h));
  return new Response(drive.body, { status: drive.status, headers });
}
