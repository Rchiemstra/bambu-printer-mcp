import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { SupportToolError, throwIfCancelled } from "../support/support-error.js";

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxDeclaredExpansionBytes: number;
  maxGcodeBytes: number;
  maxMetadataBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 4096,
  maxDeclaredExpansionBytes: 1024 * 1024 * 1024,
  maxGcodeBytes: 512 * 1024 * 1024,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
};

export interface SafeArchiveEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Unable to open ZIP archive."));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Unable to open ZIP entry stream."));
      else resolve(stream);
    });
  });
}

function safeEntryName(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new SupportToolError("UNSAFE_ZIP_ENTRY", `Unsafe ZIP entry name: ${JSON.stringify(raw)}.`);
  }
  if (raw.startsWith("/") || /^\/?[A-Za-z]:/.test(raw) || raw.startsWith("//")) {
    throw new SupportToolError("UNSAFE_ZIP_ENTRY", `Absolute ZIP entry path is not allowed: ${raw}.`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === ".." || part === "." || part.length === 0 && parts.indexOf(part) !== parts.length - 1)) {
    throw new SupportToolError("UNSAFE_ZIP_ENTRY", `Non-normal ZIP entry path is not allowed: ${raw}.`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw && `${normalized}/` !== raw) {
    throw new SupportToolError("UNSAFE_ZIP_ENTRY", `Non-normal ZIP entry path is not allowed: ${raw}.`);
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function validateEntry(entry: Entry, limits: ArchiveLimits): SafeArchiveEntry {
  const name = safeEntryName(entry.fileName);
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new SupportToolError("ENCRYPTED_ZIP_ENTRY", `Encrypted ZIP entries are not supported: ${name}.`);
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new SupportToolError("SYMLINK_ZIP_ENTRY", `Symlink ZIP entries are not allowed: ${name}.`);
  }
  const ratio = entry.compressedSize === 0
    ? (entry.uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY)
    : entry.uncompressedSize / entry.compressedSize;
  if (ratio > limits.maxCompressionRatio) {
    throw new SupportToolError("COMPRESSION_RATIO_EXCEEDED", `ZIP entry exceeds the compression-ratio limit: ${name}.`, {
      details: { compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, ratio },
    });
  }
  return { name, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, crc32: entry.crc32 };
}

async function boundedBuffer(stream: Readable, maxBytes: number, signal?: AbortSignal, deadlineMs?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const raw of stream) {
      throwIfCancelled(signal, deadlineMs);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        throw new SupportToolError("METADATA_LIMIT_EXCEEDED", "A 3MF metadata entry exceeds its byte limit.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks, total);
}

export class SecureGcode3mfReader {
  readonly sourcePath: string;
  readonly plateIndex: number;
  readonly plateNumber: number;
  readonly gcodeEntryName: string;
  readonly limits: ArchiveLimits;
  readonly entries: ReadonlyMap<string, SafeArchiveEntry>;

  private constructor(
    sourcePath: string,
    plateIndex: number,
    limits: ArchiveLimits,
    entries: Map<string, SafeArchiveEntry>
  ) {
    this.sourcePath = sourcePath;
    this.plateIndex = plateIndex;
    this.plateNumber = plateIndex + 1;
    this.gcodeEntryName = `Metadata/plate_${this.plateNumber}.gcode`;
    this.limits = limits;
    this.entries = entries;
  }

  static async open(
    sourcePath: string,
    plateIndex = 0,
    options: { signal?: AbortSignal; deadlineMs?: number; limits?: Partial<ArchiveLimits> } = {}
  ): Promise<SecureGcode3mfReader> {
    if (!Number.isInteger(plateIndex) || plateIndex < 0) {
      throw new SupportToolError("INVALID_PLATE_INDEX", "plate_index must be a non-negative integer.");
    }
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
    const resolved = path.resolve(sourcePath);
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SupportToolError("INVALID_3MF_SOURCE", "three_mf_path must refer to a regular, non-symlink file.");
    }
    if (stat.size > limits.maxArchiveBytes) {
      throw new SupportToolError("ARCHIVE_LIMIT_EXCEEDED", "3MF archive exceeds the 256 MiB default limit.");
    }
    const handle = await fs.open(resolved, "r");
    try {
      const signature = Buffer.alloc(4);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(signature[2])) {
        throw new SupportToolError("INVALID_3MF_SIGNATURE", "File is not a ZIP-based 3MF archive.");
      }
    } finally {
      await handle.close();
    }

    const zip = await openZip(resolved);
    const entries = new Map<string, SafeArchiveEntry>();
    let count = 0;
    let declaredExpansion = 0;
    try {
      while (true) {
        throwIfCancelled(options.signal, options.deadlineMs);
        let entry: Entry | null;
        try {
          entry = await nextEntry(zip);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/invalid relative path|absolute path|backslash/i.test(message)) {
            throw new SupportToolError("UNSAFE_ZIP_ENTRY", `Unsafe ZIP entry rejected: ${message}.`, { cause: error });
          }
          throw new SupportToolError("INVALID_ZIP_ARCHIVE", `Unable to read 3MF central directory: ${message}.`, { cause: error });
        }
        if (!entry) break;
        count += 1;
        if (count > limits.maxEntries) throw new SupportToolError("ARCHIVE_ENTRY_LIMIT_EXCEEDED", "3MF archive has too many entries.");
        const safe = validateEntry(entry, limits);
        const key = safe.name.toLowerCase();
        if (entries.has(key)) {
          throw new SupportToolError("DUPLICATE_ZIP_ENTRY", `Duplicate normalized ZIP entry: ${safe.name}.`);
        }
        entries.set(key, safe);
        declaredExpansion += safe.uncompressedSize;
        if (declaredExpansion > limits.maxDeclaredExpansionBytes) {
          throw new SupportToolError("ARCHIVE_EXPANSION_LIMIT_EXCEEDED", "3MF declared expansion exceeds the 1 GiB default limit.");
        }
      }
    } finally {
      zip.close();
    }
    if (!entries.has("[content_types].xml") || !entries.has("3d/3dmodel.model")) {
      throw new SupportToolError("INVALID_3MF_STRUCTURE", "Archive is missing required 3MF content types or model data.");
    }
    const expected = `metadata/plate_${plateIndex + 1}.gcode`;
    const selected = entries.get(expected);
    if (!selected) {
      throw new SupportToolError("PLATE_GCODE_NOT_FOUND", `Archive does not contain Metadata/plate_${plateIndex + 1}.gcode.`);
    }
    if (selected.uncompressedSize > limits.maxGcodeBytes) {
      throw new SupportToolError("GCODE_LIMIT_EXCEEDED", "Selected plate G-code exceeds the configured byte limit.");
    }
    const reader = new SecureGcode3mfReader(resolved, plateIndex, limits, entries);
    await reader.verifyMd5IfPresent(options.signal, options.deadlineMs);
    return reader;
  }

  hasEntry(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  async openEntryStream(name: string, signal?: AbortSignal, deadlineMs?: number): Promise<Readable> {
    const wanted = name.toLowerCase();
    if (!this.entries.has(wanted)) throw new SupportToolError("ZIP_ENTRY_NOT_FOUND", `3MF entry not found: ${name}.`);
    const zip = await openZip(this.sourcePath);
    while (true) {
      throwIfCancelled(signal, deadlineMs);
      const entry = await nextEntry(zip);
      if (!entry) { zip.close(); break; }
      if (safeEntryName(entry.fileName).toLowerCase() !== wanted) continue;
      const stream = await entryStream(zip, entry);
      const close = () => zip.close();
      stream.once("end", close);
      stream.once("close", close);
      stream.once("error", close);
      if (signal) {
        const abort = () => stream.destroy(new SupportToolError("CANCELLED", "Support analysis was cancelled."));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        stream.once("close", () => signal.removeEventListener("abort", abort));
      }
      return stream;
    }
    throw new SupportToolError("ZIP_ENTRY_NOT_FOUND", `3MF entry disappeared while reopening: ${name}.`);
  }

  openGcodeStream(signal?: AbortSignal, deadlineMs?: number): Promise<Readable> {
    return this.openEntryStream(this.gcodeEntryName, signal, deadlineMs);
  }

  async readEntryBuffer(name: string, signal?: AbortSignal, deadlineMs?: number): Promise<Buffer> {
    const metadata = this.entries.get(name.toLowerCase());
    if (!metadata) throw new SupportToolError("ZIP_ENTRY_NOT_FOUND", `3MF entry not found: ${name}.`);
    if (metadata.uncompressedSize > this.limits.maxMetadataBytes) {
      throw new SupportToolError("METADATA_LIMIT_EXCEEDED", `Metadata entry is too large: ${name}.`);
    }
    return boundedBuffer(await this.openEntryStream(name, signal, deadlineMs), this.limits.maxMetadataBytes, signal, deadlineMs);
  }

  async readOptionalEntryBuffer(name: string, signal?: AbortSignal, deadlineMs?: number): Promise<Buffer | null> {
    return this.hasEntry(name) ? this.readEntryBuffer(name, signal, deadlineMs) : null;
  }

  private async verifyMd5IfPresent(signal?: AbortSignal, deadlineMs?: number): Promise<void> {
    const md5Name = `${this.gcodeEntryName}.md5`;
    if (!this.hasEntry(md5Name)) return;
    const expectedRaw = (await this.readEntryBuffer(md5Name, signal, deadlineMs)).toString("ascii").trim();
    const expectedMatch = /^([a-fA-F0-9]{32})(?:\s+.*)?$/.exec(expectedRaw);
    if (!expectedMatch) throw new SupportToolError("MALFORMED_GCODE_CHECKSUM", "Plate G-code MD5 sidecar is malformed.");
    const hash = createHash("md5");
    const stream = await this.openGcodeStream(signal, deadlineMs);
    let bytes = 0;
    for await (const raw of stream) {
      throwIfCancelled(signal, deadlineMs);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > this.limits.maxGcodeBytes) {
        stream.destroy();
        throw new SupportToolError("GCODE_LIMIT_EXCEEDED", "Selected plate G-code exceeds its actual byte limit.");
      }
      hash.update(chunk);
    }
    const actual = hash.digest("hex");
    if (actual.toLowerCase() !== expectedMatch[1].toLowerCase()) {
      throw new SupportToolError("GCODE_CHECKSUM_MISMATCH", "Plate G-code MD5 does not match its sidecar.", {
        details: { expected: expectedMatch[1].toLowerCase(), actual },
      });
    }
  }
}
