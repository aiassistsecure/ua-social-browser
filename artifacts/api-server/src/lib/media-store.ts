/**
 * Storage for the images and videos a draft carries.
 *
 * The bytes live on disk, never in the browser state document. That document
 * is written whole on every edit — a debounce behind a textarea — so an image
 * inside it would be rewritten from scratch on every keystroke, and the
 * append-only ledger would keep every copy forever.
 *
 * Files are addressed by the SHA-256 of their contents, which buys three
 * things at once: uploading the same picture twice costs nothing, the address
 * cannot disagree with the bytes, and the shell can re-verify the file it is
 * about to upload really is the file that was approved. The last one is the
 * point — an approval is for exact content, and until now "content" only meant
 * text.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { dataDirectory } from "./store";

/** What a draft and a publish request carry. Never the bytes themselves. */
export type MediaRef = {
  id: string;
  sha256: string;
  filename: string;
  mimeType: string;
  bytes: number;
  altText?: string;
};

export type StoredMedia = MediaRef & {
  /** Absolute path. The shell reads this directly; both run as one user. */
  path: string;
};

/** Larger than any single social upload this build drives. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * What the driven networks actually accept from a file picker. An unknown type
 * is refused here rather than at the network, where the failure would look
 * like a broken selector.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

export function isSupportedMediaType(mimeType: string): boolean {
  return normaliseMime(mimeType) in EXTENSION_BY_MIME;
}

function normaliseMime(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/**
 * Reduces a client-supplied name to something safe to write and safe to hand
 * to a file input.
 *
 * The name reaches the network — it is what the upload is called — so it is
 * worth keeping recognisable. It also becomes a path segment, so anything that
 * could climb out of the media directory is removed rather than escaped:
 * `path.basename` first, then a conservative character class.
 */
export function safeFilename(input: string, mimeType: string): string {
  const extension = EXTENSION_BY_MIME[normaliseMime(mimeType)] ?? "";
  const base = path
    .basename(input.replace(/\\/g, "/"))
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 100);

  if (base === "" || base === extension.replace(/^\./, "")) {
    return `upload${extension}`;
  }
  return base.toLowerCase().endsWith(extension.toLowerCase())
    ? base
    : `${base}${extension}`;
}

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tenantRoot(tenantId: string): string {
  // The tenant id is a path segment too; single-tenant mode supplies
  // "personal", but multi-tenant mode will supply whatever an auth layer says.
  const safe = tenantId.replace(/[^A-Za-z0-9._-]/g, "-") || "unknown";
  return path.join(dataDirectory, "media", safe);
}

/**
 * The directory is named for the hash and the file keeps its own name, so the
 * address stays content-derived while the upload still arrives at the network
 * called something a person would recognise.
 */
function locationFor(
  tenantId: string,
  sha256: string,
  filename: string,
): { directory: string; file: string } {
  const directory = path.join(tenantRoot(tenantId), sha256);
  return { directory, file: path.join(directory, filename) };
}

export function storeMedia(input: {
  tenantId: string;
  bytes: Buffer;
  filename: string;
  mimeType: string;
}): StoredMedia {
  const mimeType = normaliseMime(input.mimeType);
  const filename = safeFilename(input.filename, mimeType);
  const sha256 = sha256Of(input.bytes);
  const { directory, file } = locationFor(input.tenantId, sha256, filename);

  mkdirSync(directory, { recursive: true });

  // Same bytes, same name, already here: uploading a picture twice is free and
  // must not rewrite a file the shell might be reading at this moment.
  if (!existsSync(file)) {
    // Written beside the target and moved into place, so a crash mid-write
    // cannot leave a truncated file sitting at an address that promises its
    // own hash.
    const pending = `${file}.pending-${process.pid}`;
    writeFileSync(pending, input.bytes);
    renameSync(pending, file);
  }

  return {
    id: `${sha256}/${filename}`,
    sha256,
    filename,
    mimeType,
    bytes: input.bytes.length,
    path: file,
  };
}

/** Resolves an id back to a file, refusing anything that leaves the root. */
export function resolveMedia(
  tenantId: string,
  id: string,
): StoredMedia | null {
  const [sha256, ...rest] = id.split("/");
  const filename = rest.join("/");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || filename === "") return null;
  if (filename !== path.basename(filename)) return null;

  const { file } = locationFor(tenantId, sha256, filename);
  const root = tenantRoot(tenantId);
  if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) return null;
  if (!existsSync(file)) return null;

  const stats = statSync(file);
  return {
    id,
    sha256,
    filename,
    mimeType: mimeFromFilename(filename),
    bytes: stats.size,
    path: file,
  };
}

function mimeFromFilename(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  for (const [mime, ext] of Object.entries(EXTENSION_BY_MIME)) {
    if (ext === extension) return mime;
  }
  return "application/octet-stream";
}

export function readMedia(tenantId: string, id: string): Buffer | null {
  const stored = resolveMedia(tenantId, id);
  return stored ? readFileSync(stored.path) : null;
}

/**
 * Confirms a stored file still hashes to the address it is filed under.
 *
 * Cheap paranoia that pays for itself at exactly one moment: just before the
 * shell hands a path to a network. If the file on disk is not the file that
 * was approved, the post must not go out, and "the address is the hash" is
 * only a guarantee if something checks.
 */
export function verifyMedia(tenantId: string, ref: MediaRef): StoredMedia | null {
  const stored = resolveMedia(tenantId, ref.id);
  if (!stored) return null;
  if (stored.sha256 !== ref.sha256) return null;
  const actual = sha256Of(readFileSync(stored.path));
  return actual === ref.sha256 ? stored : null;
}

/**
 * The identity of a set of attachments, for comparing an approval against what
 * is being sent. Order matters — it is the order they post in — and so does
 * alt text, which is published content in its own right.
 */
export function mediaFingerprint(media: readonly MediaRef[] | undefined): string {
  if (!media || media.length === 0) return "";
  return media
    .map((item) => `${item.sha256}:${(item.altText ?? "").trim()}`)
    .join("|");
}
