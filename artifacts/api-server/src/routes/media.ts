import { Router, type IRouter } from "express";
import express from "express";
import {
  MAX_MEDIA_BYTES,
  isSupportedMediaType,
  readMedia,
  resolveMedia,
  storeMedia,
} from "../lib/media-store";
import { tenantOrUnauthorized } from "../lib/tenant";

const router: IRouter = Router();

/**
 * Raw bytes rather than multipart.
 *
 * One file per request, the name in a header and the type in `Content-Type`,
 * which is all this needs — and it avoids adding a multipart parser to a
 * dependency tree that is deliberately small and guarded by a release-age
 * floor. `express.json()` upstream only claims `application/json`, so an image
 * content-type arrives here untouched.
 */
const rawBody = express.raw({ type: "*/*", limit: MAX_MEDIA_BYTES });

router.post("/media", rawBody, (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  const filename = req.header("x-filename");
  if (!filename || filename.trim() === "") {
    return res.status(400).json({
      error:
        "An upload needs its original filename in the x-filename header; the network shows that name on the post.",
    });
  }

  const mimeType = req.header("content-type") ?? "";
  if (!isSupportedMediaType(mimeType)) {
    return res.status(400).json({
      error: `This build does not upload ${mimeType || "files with no content type"}. Use a JPEG, PNG, GIF, WebP, MP4, or MOV.`,
    });
  }

  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return res
      .status(400)
      .json({ error: "The upload was empty; nothing was stored." });
  }

  const stored = storeMedia({
    tenantId,
    bytes,
    filename: filename.trim(),
    mimeType,
  });

  req.log.info(
    { mediaId: stored.id, bytes: stored.bytes, mimeType: stored.mimeType },
    "Stored an upload",
  );

  // The path stays on this side. A browser has no use for it, and the shell
  // resolves its own from the id against the same data directory.
  return res.status(201).json({
    media: {
      id: stored.id,
      sha256: stored.sha256,
      filename: stored.filename,
      mimeType: stored.mimeType,
      bytes: stored.bytes,
    },
  });
});

// Two named segments rather than a wildcard: an id *is* `<sha256>/<filename>`,
// and Express 5's router rejects a bare `*` outright — a mistake that takes the
// whole server down at startup rather than failing this one route.
router.get("/media/:sha/:filename", (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  const id = `${req.params.sha}/${req.params.filename}`;

  const stored = resolveMedia(tenantId, id);
  const bytes = stored ? readMedia(tenantId, id) : null;
  if (!stored || !bytes) {
    return res.status(404).json({ error: "No such upload." });
  }

  res.setHeader("Content-Type", stored.mimeType);
  res.setHeader("Content-Length", String(bytes.length));
  // Content-addressed, so the bytes at an id can never change.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  return res.end(bytes);
});

export default router;
