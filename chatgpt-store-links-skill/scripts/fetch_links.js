#!/usr/bin/env node
"use strict";

/*
 * Discover official Microsoft Store ChatGPT Work/Codex MSIX URLs.
 *
 * This script uses only Node.js built-ins. It keeps cookies and SOAP
 * responses in memory, discovers the current package through StoreEdge/FE3,
 * and never installs the package or obtains a Store license.
 */

const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const os = require("os");

const DEFAULT_PRODUCT_ID = "9PLM9XGG6VKS";
const EXPECTED_PACKAGE_FAMILY_NAME = "OpenAI.Codex_2p2nqsd0c76g0";
const EXPECTED_PRODUCT_TITLE = "ChatGPT";
const EXPECTED_PUBLISHER = "OpenAI";
const STOREEDGE_HOST = "storeedgefd.dsx.mp.microsoft.com";
const FE3_HOST = "fe3.delivery.mp.microsoft.com";
const FE3_URL = "https://" + FE3_HOST + "/ClientWebService/client.asmx";
const FE3_SECURED_URL = FE3_URL + "/secured";
const ALLOWED_CDN_HOSTS = new Set([
  "dl.delivery.mp.microsoft.com",
  "tlu.dl.delivery.mp.microsoft.com",
]);
// StoreEdge can advertise architectures that are known to Windows but outside
// this skill's x64/arm64 retrieval scope. Reject values outside this set so a
// protocol drift cannot silently alter the architecture decision.
const KNOWN_STOREEDGE_PLATFORM_VALUES = new Set([
  "x86",
  "x64",
  "arm",
  "arm64",
  "neutral",
]);
const WINDOWS_RESERVED_BASENAME_RE =
  /^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|\u00b9|\u00b2|\u00b3)|LPT(?:[1-9]|\u00b9|\u00b2|\u00b3)|CLOCK\$)$/i;
const WINDOWS_FILENAME_MAX_LENGTH = 255;
const HEAD_FALLBACK_STATUSES = new Set([400, 403, 405, 501]);
const RETRYABLE_HTTP_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ERR_SOCKET_TIMEOUT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TLS_CERT_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const TLS_CERT_ERROR_MESSAGE_RE =
  /unable to (?:get local issuer certificate|verify the first certificate|verify leaf signature)|self[- ]signed certificate|certificate (?:has expired|is not yet valid)|hostname\/ip does not match certificate(?:'s)? altnames|certificate signature failure/i;
const MAX_STAGE_ATTEMPTS = 3;
const MAX_URL_PROBE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// Compatibility default for environments that do not ship the Microsoft
// Update root in the Node.js trust store. Use --strict-tls when certificate
// validation is required for the result.
const DEFAULT_INSECURE_TLS = true;
const INSECURE_TLS_WARNING =
  "TLS 证书校验已关闭；结果不适合作为严格安全验证。";
// Keep terminal, JSON and URL-boundary values free of invisible formatting
// controls that can spoof log output (for example bidi overrides).
const UNSAFE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
const UNSAFE_CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 " +
  "Safari/537.36 Edg/149.0.0.0";

function configureUtf8Output() {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.setDefaultEncoding === "function") {
      stream.setDefaultEncoding("utf8");
    }
  }
}

function safeKernelRelease() {
  try {
    return typeof os.release === "function" ? String(os.release() || "") : "";
  } catch (error) {
    return "";
  }
}

// Keep redirected output UTF-8 on Node.js runtimes where the stream default
// could otherwise follow a platform-specific encoding.
configureUtf8Output();

// Public Windows Update device token used by the Store download protocol.
// It is not a user credential. The seed IDs are the stable protocol seed.
const DEVICE_TOKEN =
  "dAA9AEUAdwBBAHcAQQBzAE4AMwBCAEEAQQBVADEAYgB5AHMAZQBtAGIAZQBEAFYAQwArADMA" +
  "ZgBtADcAbwBXAHkASAA3AGIAbgBnAEcAWQBtAEEAQQBMAGoAbQBqAFYAVQB2AFEAYwA0AEsA" +
  "VwBFAC8AYwBDAEwANQBYAGUANABnAHYAWABkAGkAegBHAGwAZABjADEAZAAvAFcAeQAvAHgA" +
  "SgBQAG4AVwBRAGUAYwBtAHYAbwBjAGkAZwA5AGoAZABwAE4AawBIAG0AYQBzAHAAVABKAEwA" +
  "RAArAFAAYwBBAFgAbQAvAFQAcAA3AEgAagBzAEYANAA0AEgAdABsAC8AMQBtAHUAcgAwAFMA" +
  "dQBtAG8AMABZAGEAdgBqAFIANwArADQAcABoAC8AcwA4ADEANgBFAFkANQBNAFIAbQBnAFIA" +
  "QwA2ADMAQwBSAEoAQQBVAHYAZgBzADQAaQB2AHgAYwB5AEwAbAA2AHoAOABlAHgAMABrAFgA" +
  "OQBPAHcAYQB0ADEAdQBwAFMAOAAxAEgANgA4AEEASABzAEoAegBnAFQAQQBMAG8AbgBBADIA" +
  "WQBBAEEAQQBpAGcANQBJADMAUQAvAFYASABLAHcANABBAEIAcQA5AFMAcQBhADEAQgA4AGsA" +
  "VQAxAGEAbwBLAEEAdQA0AHYAbABWAG4AdwBWADMAUQB6AHMATgBtAEQAaQBqAGgANQBkAEcA" +
  "cgBpADgAQQBlAEUARQBWAEcAbQBXAGgASQBCAE0AUAAyAEQAVwA0ADMAZABWAGkARABUAHoA" +
  "VQB0AHQARQBMAEgAaABSAGYAcgBhAGIAWgBsAHQAQQBUAEUATABmAHMARQBGAFUAYQBRAFMA" +
  "SgB4ADUAeQBRADgAagBaAEUAZQAyAHgANABCADMAMQB2AEIAMgBqAC8AUgBLAGEAWQAvAHEA" +
  "eQB0AHoANwBUAHYAdAB3AHQAagBzADYAUQBYAEIAZQA4AHMAZwBJAG8AOQBiADUAQQBCADcA" +
  "OAAxAHMANgAvAGQAUwBFAHgATgBEAEQAYQBRAHoAQQBYAFAAWABCAFkAdQBYAFEARQBzAE8A" +
  "egA4AHQAcgBpAGUATQBiAEIAZQBUAFkAOQBiAG8AQgBOAE8AaQBVADcATgBSAEYAOQAzAG8A" +
  "VgArAFYAQQBiAGgAcAAwAHAAUgBQAFMAZQBmAEcARwBPAHEAdwBTAGcANwA3AHMAaAA5AEoA" +
  "SABNAHAARABNAFMAbgBrAHEAcgAyAGYARgBpAEMAUABrAHcAVgBvAHgANgBuAG4AeABGAEQA" +
  "bwBXAC8AYQAxAHQAYQBaAHcAegB5AGwATABMADEAMgB3AHUAYgBtADUAdQBtAHAAcQB5AFcA" +
  "YwBLAFIAagB5AGgAMgBKAFQARgBKAFcANQBnAFgARQBJADUAcAA4ADAARwB1ADIAbgB4AEwA" +
  "UgBOAHcAaQB3AHIANwBXAE0AUgBBAFYASwBGAFcATQBlAFIAegBsADkAVQBxAGcALwBwAFgA" +
  "LwB2AGUATAB3AFMAawAyAFMAUwBIAGYAYQBLADYAagBhAG8AWQB1AG4AUgBHAHIAOABtAGIA" +
  "RQBvAEgAbABGADYASgBDAGEAYQBUAEIAWABCAGMAdgB1AGUAQwBKAG8AOQA4AGgAUgBBAHIA" +
  "RwB3ADQAKwBQAEgAZQBUAGIATgBTAEUAWABYAHoAdgBaADYAdQBXADUARQBBAGYAZABaAG0A" +
  "UwA4ADgAVgBKAGMAWgBhAEYASwA3AHgAeABnADAAdwBvAG4ANwBoADAAeABDADYAWgBCADAA" +
  "YwBZAGoATAByAC8ARwBlAE8AegA5AEcANABRAFUASAA5AEUAawB5ADAAZAB5AEYALwByAGUA" +
  "VQAxAEkAeQBpAGEAcABwAGgATwBQADgAUwAyAHQANABCAHIAUABaAFgAVAB2AEMAMABQADcA" +
  "egBPACsAZgBHAGsAeABWAG0AKwBVAGYAWgBiAFEANQA1AHMAdwBFAD0AJgBwAD0A"
;

const INSTALLED_NON_LEAF_IDS = (
  "1 2 3 11 19 544 549 2359974 2359977 5169044 8788830 " +
  "23110993 23110994 54341900 54343656 59830006 59830007 59830008 " +
  "60484010 62450018 62450019 62450020 66027979 66053150 97657898 " +
  "98822896 98959022 98959023 98959024 98959025 104433538 104900364 " +
  "105489019 117765322 129905029 130040031 132387090 132393049 " +
  "133399034 138537048 140377312 143747671 158941041 158941042 " +
  "158941043 158941044 159123858 159130928 164836897 164847386"
).split(/\s+/);

class DiscoveryError extends Error {
  constructor(message, options) {
    super(String(message || "获取失败"));
    this.name = "DiscoveryError";
    const details = options && typeof options === "object" ? options : {};
    if (details.code) this.code = String(details.code);
    if (details.stage) this.stage = String(details.stage);
    if (details.retryable !== undefined) this.retryable = Boolean(details.retryable);
    if (details.architecture) this.architecture = String(details.architecture);
    if (details.httpStatus !== undefined) this.http_status = Number(details.httpStatus);
    if (details.retryAfterMs !== undefined) this.retry_after_ms = Number(details.retryAfterMs);
    if (details.tlsMode) this.tls_mode = String(details.tlsMode);
  }
}

function annotateError(error, defaults) {
  const value = error instanceof Error ? error : new DiscoveryError(String(error));
  const details = defaults && typeof defaults === "object" ? defaults : {};
  if (!value.code && details.code) value.code = String(details.code);
  if (!value.stage && details.stage) value.stage = String(details.stage);
  if (value.retryable === undefined && details.retryable !== undefined) {
    value.retryable = Boolean(details.retryable);
  }
  if (value.architecture === undefined && details.architecture) {
    value.architecture = String(details.architecture);
  }
  if (value.http_status === undefined && details.httpStatus !== undefined) {
    value.http_status = Number(details.httpStatus);
  }
  if (value.retry_after_ms === undefined && details.retryAfterMs !== undefined) {
    value.retry_after_ms = Number(details.retryAfterMs);
  }
  if (value.tls_mode === undefined && details.tlsMode) {
    value.tls_mode = String(details.tlsMode);
  }
  return value;
}

async function withStage(operation, defaults) {
  try {
    return await operation();
  } catch (error) {
    throw annotateError(error, defaults);
  }
}

function retryAfterMs(headers) {
  // Retry-After is normally a single field. If a client library exposes
  // duplicate values as an array, use the first valid value instead of
  // joining them into an unparsable comma-delimited string.
  const values = headerValues(headers, "retry-after");
  for (const candidate of values) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    if (/^\d+$/.test(value)) {
      return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
    }
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) {
      return Math.max(0, Math.min(timestamp - Date.now(), MAX_RETRY_AFTER_MS));
    }
  }
  return 0;
}

function isRetryableNetworkError(error) {
  const code = error && String(error.code || "").toUpperCase();
  return RETRYABLE_NETWORK_CODES.has(code);
}

function isTlsCertificateError(error) {
  const code = error && String(error.code || "").toUpperCase();
  if (TLS_CERT_ERROR_CODES.has(code)) return true;
  const message = error && typeof error.message === "string" ? error.message : "";
  return TLS_CERT_ERROR_MESSAGE_RE.test(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function retryDelayMs(error, attempt) {
  if (Number.isSafeInteger(error && error.retry_after_ms) && error.retry_after_ms > 0) {
    return Math.min(error.retry_after_ms, MAX_RETRY_AFTER_MS);
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS);
}

async function retryOperation(operation, defaults, options) {
  const settings = Object.assign({ maxAttempts: MAX_STAGE_ATTEMPTS }, options || {});
  if (!Number.isSafeInteger(settings.maxAttempts) || settings.maxAttempts < 1) {
    throw new DiscoveryError("重试次数配置无效", {
      code: "skill_configuration_error",
      stage: "configuration",
    });
  }
  let lastError = null;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const normalized = annotateError(error, defaults);
      normalized.attempts = attempt;
      lastError = normalized;
      if (attempt >= settings.maxAttempts || normalized.retryable !== true) {
        throw normalized;
      }
      await sleep(retryDelayMs(normalized, attempt));
    }
  }
  throw lastError || new DiscoveryError("可恢复操作失败", defaults);
}

function sanitizeMessage(value, maxLength) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 2048;
  const cleaned = String(value === undefined || value === null ? "" : value)
    .replace(ANSI_ESCAPE_RE, "")
    .replace(UNSAFE_CONTROL_GLOBAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "获取失败";
  return cleaned.length > limit ? cleaned.slice(0, limit) + "..." : cleaned;
}

function sanitizeHeaderValue(value, maxLength) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 4096;
  const cleaned = String(value === undefined || value === null ? "" : value)
    .replace(ANSI_ESCAPE_RE, "")
    .replace(UNSAFE_CONTROL_GLOBAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > limit ? cleaned.slice(0, limit) + "..." : cleaned;
}

function validateWindowsFilename(value, label) {
  const name = String(value === undefined || value === null ? "" : value);
  const message = label || "文件名无效";
  const normalizedStem = name.split(".", 1)[0].replace(/[ .]+$/g, "");
  if (
    !name ||
    name.length > WINDOWS_FILENAME_MAX_LENGTH ||
    name === "." ||
    name === ".." ||
    UNSAFE_CONTROL_RE.test(name) ||
    /[<>:"/\\|?*]/.test(name) ||
    /[ .]$/.test(name) ||
    WINDOWS_RESERVED_BASENAME_RE.test(normalizedStem)
  ) {
    throw new DiscoveryError(message);
  }
  return name;
}

function addMetadataWarning(warnings, message) {
  if (Array.isArray(warnings) && warnings.length < 16) warnings.push(message);
}

function retryableHttpStatus(status) {
  // HEAD fallback statuses (400/405/501) are protocol fallbacks, not retry
  // signals. 403 remains retryable because a signed CDN URL may have expired.
  return RETRYABLE_HTTP_STATUSES.has(Number(status));
}

function errorObject(error) {
  const value = error instanceof Error ? error : new DiscoveryError(String(error));
  const result = {
    error_code: value.code || "discovery_error",
    message: sanitizeMessage(value.message),
    stage: value.stage || "discovery",
    retryable: value.retryable === true,
    next_action: nextActionForError(value),
  };
  if (value.architecture) result.architecture = value.architecture;
  if (Number.isSafeInteger(value.http_status) && value.http_status > 0) {
    result.http_status = value.http_status;
  }
  if (Number.isSafeInteger(value.retry_after_ms) && value.retry_after_ms > 0) {
    result.retry_after_ms = value.retry_after_ms;
  }
  if (Number.isSafeInteger(value.attempts) && value.attempts > 0) {
    result.attempts = value.attempts;
  }
  if (value.tls_mode) result.tls_mode = String(value.tls_mode);
  return result;
}

function nowUtc() {
  return new Date();
}

function isoUtc(value) {
  return new Date(value).toISOString();
}

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

function isValidTimestamp(value) {
  const text = String(value || "").trim();
  const match = ISO_TIMESTAMP_RE.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const zone = match[7].toUpperCase();
  if (zone !== "Z" && !/^[-+]\d{2}:\d{2}$/.test(zone)) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }
  return !Number.isNaN(Date.parse(text));
}

function localName(name) {
  const text = String(name || "");
  const colon = text.lastIndexOf(":");
  const brace = text.lastIndexOf("}");
  return text.slice(Math.max(colon, brace) + 1);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function trimXmlWhitespace(value) {
  return String(value || "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function isXmlWhitespace(value) {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function validateXmlCharacters(value) {
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint > 0xffff) index += 1;
    const valid =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) throw new DiscoveryError("XML 含有非法字符");
  }
  return text;
}

function decodeEntities(value) {
  const decoded = String(value || "").replace(/&([^;]*);|&/g, (whole, entity) => {
    if (entity === undefined) throw new DiscoveryError("XML 含有未转义的 &");
    const lower = entity.toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (!lower.startsWith("#x") && !lower.startsWith("#")) {
      throw new DiscoveryError("XML 含有未知字符实体");
    }
    const hexadecimal = lower.startsWith("#x");
    const digits = hexadecimal ? lower.slice(2) : lower.slice(1);
    if (
      !digits ||
      (hexadecimal ? !/^[0-9a-f]+$/.test(digits) : !/^\d+$/.test(digits))
    ) {
      throw new DiscoveryError("XML 字符实体无效");
    }
    const codePoint = parseInt(digits, hexadecimal ? 16 : 10);
    const validXmlCodePoint =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!Number.isSafeInteger(codePoint) || !validXmlCodePoint) {
      throw new DiscoveryError("XML 字符实体无效");
    }
    return String.fromCodePoint(codePoint);
  });
  return validateXmlCharacters(decoded);
}

function parseAttributes(source) {
  const attrs = Object.create(null);
  let index = 0;
  while (index < source.length) {
    while (isXmlWhitespace(source[index])) index += 1;
    if (index >= source.length) break;
    const match = /^([^ \t\r\n=/>]+)[ \t\r\n]*=[ \t\r\n]*/.exec(source.slice(index));
    if (!match) throw new DiscoveryError("XML 属性语法无效");
    const name = match[1];
    index += match[0].length;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") throw new DiscoveryError("XML 属性值必须使用引号");
    index += 1;
    const end = source.indexOf(quote, index);
    if (end < 0) throw new DiscoveryError("XML 属性值未闭合");
    const rawValue = source.slice(index, end);
    if (rawValue.includes("<")) throw new DiscoveryError("XML 属性值含有未转义的 <");
    if (Object.prototype.hasOwnProperty.call(attrs, name)) {
      throw new DiscoveryError("XML 属性重复：" + name);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) {
      throw new DiscoveryError("XML 属性名无效");
    }
    if (Object.keys(attrs).some((existing) => localName(existing) === localName(name))) {
      throw new DiscoveryError("XML 属性本地名称重复：" + localName(name));
    }
    attrs[name] = decodeEntities(rawValue);
    index = end + 1;
  }
  return attrs;
}

/*
 * Small namespace-tolerant XML reader for the fixed FE3/Store SOAP shapes.
 * It is deliberately not a general-purpose XML implementation.
 */
function parseXml(source) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let index = 0;
  const input = String(source || "").replace(/^\uFEFF/, "");

  while (index < input.length) {
    if (input[index] !== "<") {
      const next = input.indexOf("<", index);
      const end = next < 0 ? input.length : next;
      const text = decodeEntities(input.slice(index, end));
      if (stack.length === 1 && trimXmlWhitespace(text)) {
        throw new DiscoveryError("XML 根元素外含有非空文本");
      }
      stack[stack.length - 1].text += text;
      index = end;
      continue;
    }
    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4);
      if (end < 0) throw new DiscoveryError("XML 注释未闭合");
      const comment = input.slice(index + 4, end);
      validateXmlCharacters(comment);
      if (comment.includes("--")) {
        throw new DiscoveryError("XML 注释内容无效");
      }
      index = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", index)) {
      const end = input.indexOf("]]>", index + 9);
      if (end < 0) throw new DiscoveryError("XML CDATA 未闭合");
      if (stack.length === 1) throw new DiscoveryError("XML 根元素外不允许 CDATA");
      stack[stack.length - 1].text += validateXmlCharacters(input.slice(index + 9, end));
      index = end + 3;
      continue;
    }
    let end = index + 1;
    let quote = null;
    for (; end < input.length; end += 1) {
      const character = input[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= input.length) throw new DiscoveryError("XML 标签未闭合");
    let token = trimXmlWhitespace(input.slice(index + 1, end));
    index = end + 1;
    if (!token) throw new DiscoveryError("XML 标签为空");
    if (token[0] === "?") {
      validateXmlCharacters(token);
      if (!/^\?[A-Za-z_][A-Za-z0-9_.:-]*(?:[\s\S]*)\?$/.test(token)) {
        throw new DiscoveryError("XML 处理指令无效");
      }
      continue;
    }
    if (token[0] === "!") throw new DiscoveryError("XML 不支持声明");
    if (token[0] === "/") {
      if (stack.length <= 1) throw new DiscoveryError("XML 结束标签层级错误");
      const closeMatch = /^\/[ \t\r\n]*([^ \t\r\n/>]+)[ \t\r\n]*$/.exec(token);
      if (!closeMatch) throw new DiscoveryError("XML 结束标签无效");
      const openNode = stack[stack.length - 1];
      if (openNode.name !== closeMatch[1]) {
        throw new DiscoveryError("XML 开始和结束标签不匹配");
      }
      stack.pop();
      continue;
    }
    const selfClosing = /\/[ \t\r\n]*$/.test(token);
    if (selfClosing) token = trimXmlWhitespace(token.replace(/\/[ \t\r\n]*$/, ""));
    const nameMatch = /^([^ \t\r\n/>]+)/.exec(token);
    if (!nameMatch) throw new DiscoveryError("XML 标签缺少名称");
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(nameMatch[1])) {
      throw new DiscoveryError("XML 标签名无效");
    }
    const node = {
      name: nameMatch[1],
      attrs: parseAttributes(token.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new DiscoveryError("XML 文档未闭合");
  if (root.children.length !== 1) throw new DiscoveryError("XML 文档必须只有一个根元素");
  return root;
}

function* walk(node) {
  const pending = Array.from(node.children || []).reverse();
  while (pending.length) {
    const child = pending.pop();
    yield child;
    const children = child.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
}

function findNodes(node, name) {
  return Array.from(walk(node)).filter((item) => localName(item.name) === name);
}

function getAttr(node, name) {
  for (const [key, value] of Object.entries(node.attrs || {})) {
    if (localName(key) === name) return value;
  }
  return "";
}

function childNode(node, name) {
  return (node.children || []).find((item) => localName(item.name) === name) || null;
}

function childNodes(node, name) {
  return (node.children || []).filter((item) => localName(item.name) === name);
}

function childText(node, name) {
  const item = childNode(node, name);
  return item ? String(item.text || "").trim() : "";
}

function uniqueChildNode(node, name, message, options) {
  const matches = childNodes(node, name);
  const details = Object.assign(
    { code: "fe3_metadata_incomplete", stage: "fe3" },
    options || {}
  );
  if (matches.length !== 1) {
    throw new DiscoveryError(message, details);
  }
  return matches[0];
}

function nonEmptyDescendants(node, name) {
  return findNodes(node, name).filter((item) => String(item.text || "").trim());
}

function descendantText(node, name) {
  for (const item of walk(node)) {
    if (localName(item.name) === name && String(item.text || "").trim()) {
      return String(item.text || "").trim();
    }
  }
  return "";
}

function parseFragment(value) {
  // The outer SOAP parser has already decoded the escaped fragment markup.
  // Parse the fragment itself so entities in its attributes/text are decoded
  // exactly once by parseXml (including values such as URL query parameters).
  let raw = trimXmlWhitespace(value);
  raw = raw.replace(/^\uFEFF/, "");
  raw = trimXmlWhitespace(raw.replace(/^<\?xml(?:[ \t\r\n][\s\S]*?)\?>/i, ""));
  if (!raw) throw new DiscoveryError("FE3 返回了空的 XML 片段");
  return parseXml("<fragment>" + raw + "</fragment>");
}

function ensureAllowedHost(url, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new DiscoveryError("未配置允许访问的主机白名单", {
      code: "skill_configuration_error",
      stage: "configuration",
    });
  }
  const raw = String(url || "");
  if (UNSAFE_CONTROL_RE.test(raw)) {
    throw new DiscoveryError("URL 含有控制字符");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new DiscoveryError("URL 无效");
  }
  if (parsed.protocol !== "https:") {
    throw new DiscoveryError("仅允许通过 HTTPS 访问微软服务");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new DiscoveryError("URL 含有不允许的凭据或片段");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new DiscoveryError("URL 使用了不允许的端口");
  }
  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new DiscoveryError("拒绝访问未授权主机：" + parsed.hostname);
  }
  return parsed;
}

function hasHeader(headers, name) {
  const source = headers && typeof headers === "object" ? headers : {};
  const normalizedName = String(name).toLowerCase();
  return Object.keys(source).some((key) => String(key).toLowerCase() === normalizedName);
}

function requestBytes(rawUrl, options) {
  const settings = Object.assign(
    {
      method: "GET",
      body: null,
      timeout: 45000,
      insecureTls: DEFAULT_INSECURE_TLS,
      headers: {},
      allowedHosts: [],
      maxRedirects: 5,
      maxBodyBytes: MAX_RESPONSE_BYTES,
      captureBody: true,
      capturePrefixBytes: 0,
    },
    options || {}
  );
  if (!Number.isSafeInteger(settings.maxBodyBytes) || settings.maxBodyBytes <= 0) {
    throw new DiscoveryError("响应大小限制无效");
  }
  if (!Number.isFinite(settings.timeout) || settings.timeout <= 0) {
    throw new DiscoveryError("请求超时配置无效", {
      code: "skill_configuration_error",
      stage: "configuration",
    });
  }
  if (!Number.isSafeInteger(settings.maxRedirects) || settings.maxRedirects < 0) {
    throw new DiscoveryError("重定向次数配置无效", {
      code: "skill_configuration_error",
      stage: "configuration",
    });
  }
  if (
    !Number.isSafeInteger(settings.capturePrefixBytes) ||
    settings.capturePrefixBytes < 0 ||
    settings.capturePrefixBytes > settings.maxBodyBytes
  ) {
    throw new DiscoveryError("响应前缀大小限制无效");
  }
  const parsed = ensureAllowedHost(rawUrl, settings.allowedHosts);
  const transport = https;
  const headers = Object.assign(
    { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
    settings.headers
  );
  if (!settings.captureBody && !hasHeader(headers, "Connection")) {
    headers.Connection = "close";
  }
  if (settings.body !== null && !hasHeader(headers, "Content-Length")) {
    headers["Content-Length"] = Buffer.byteLength(settings.body);
  }
  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: parsed.pathname + parsed.search,
    method: settings.method,
    headers,
  };
  if (parsed.protocol === "https:") requestOptions.rejectUnauthorized = !settings.insecureTls;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle;
    let redirecting = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      callback(value);
    };
    const req = transport.request(requestOptions, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && settings.maxRedirects > 0) {
        redirecting = true;
        res.on("error", () => {});
        res.on("aborted", () => {});
        // The redirect body is irrelevant; close it so a stalled response
        // cannot keep the process alive while the next request runs.
        res.destroy();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        req.setTimeout(0);
        let nextUrl;
        try {
          if (UNSAFE_CONTROL_RE.test(String(location || ""))) {
            throw new DiscoveryError("重定向地址含有控制字符");
          }
          nextUrl = new URL(location, parsed).toString();
          ensureAllowedHost(nextUrl, settings.allowedHosts);
        } catch (error) {
          finish(reject, error instanceof DiscoveryError ? error : new DiscoveryError("重定向地址无效"));
          return;
        }
        requestBytes(nextUrl, Object.assign({}, settings, { maxRedirects: settings.maxRedirects - 1 }))
          .then((value) => finish(resolve, value))
          .catch((error) => finish(reject, error));
        return;
      }
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.on("error", () => {});
        res.on("aborted", () => {});
        res.destroy();
        finish(
          reject,
          new DiscoveryError("重定向次数超过限制", {
            code: "redirect_limit",
            stage: "network_redirect",
            retryable: false,
          })
        );
        return;
      }

      const result = {
        statusCode: Number(res.statusCode || 0),
        headers: res.headers,
        body: Buffer.alloc(0),
        url: parsed.toString(),
      };
      if (settings.captureBody && settings.capturePrefixBytes === 0) {
        const rawContentLength = headerValue(res.headers, "content-length").trim();
        if (/^\d+$/.test(rawContentLength)) {
          const announcedLength = Number(rawContentLength);
          if (
            Number.isSafeInteger(announcedLength) &&
            announcedLength > settings.maxBodyBytes
          ) {
            res.on("error", () => {});
            res.on("aborted", () => {});
            res.destroy();
            finish(
              reject,
              new DiscoveryError(
                "网络响应超过大小限制（" + settings.maxBodyBytes + " 字节）",
                {
                  code: "response_too_large",
                  stage: "network_response",
                  retryable: false,
                }
              )
            );
            return;
          }
        }
      }
      if (!settings.captureBody) {
        res.on("error", () => {});
        res.on("aborted", () => {});
        res.destroy();
        finish(resolve, result);
        return;
      }
      const chunks = [];
      let receivedBytes = 0;
      let responseEnded = false;
      res.on("data", (chunk) => {
        if (settings.capturePrefixBytes > 0) {
          const remaining = settings.capturePrefixBytes - receivedBytes;
          if (remaining > 0) {
            const prefix = Buffer.from(chunk).subarray(0, remaining);
            chunks.push(prefix);
            receivedBytes += prefix.length;
          }
          if (receivedBytes >= settings.capturePrefixBytes) {
            result.body = Buffer.concat(chunks);
            finish(resolve, result);
            res.destroy();
          }
          return;
        }
        receivedBytes += chunk.length;
        if (receivedBytes > settings.maxBodyBytes) {
          res.destroy();
          finish(
            reject,
            new DiscoveryError("网络响应超过大小限制（" + settings.maxBodyBytes + " 字节）", {
              code: "response_too_large",
              stage: "network_response",
              retryable: false,
            })
          );
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        responseEnded = true;
        result.body = Buffer.concat(chunks);
        finish(resolve, result);
      });
      res.on("error", (error) => {
        if (!redirecting) {
          const message = error && error.message ? error.message : String(error);
          const retryable = isRetryableNetworkError(error);
          finish(
            reject,
            new DiscoveryError("网络响应失败：" + message + " (" + parsed.hostname + ")", {
              code: retryable ? "network_error" : "network_response_error",
              retryable,
            })
          );
        }
      });
      res.on("aborted", () => {
        if (!redirecting) {
          finish(
            reject,
            new DiscoveryError("网络响应被中止 (" + parsed.hostname + ")", {
              code: "network_error",
              retryable: true,
            })
          );
        }
      });
      res.on("close", () => {
        if (!redirecting && !responseEnded && !settled) {
          finish(
            reject,
            new DiscoveryError("网络响应提前关闭 (" + parsed.hostname + ")", {
              code: "network_error",
              retryable: true,
            })
          );
        }
      });
    });
    req.on("error", (error) => {
      if (redirecting) return;
      const message = error && error.message ? error.message : String(error);
      if (error instanceof DiscoveryError) {
        finish(reject, error);
        return;
      }
      const tlsError = isTlsCertificateError(error);
      const retryable = !tlsError && isRetryableNetworkError(error);
      finish(
        reject,
        new DiscoveryError("网络请求失败：" + message + " (" + parsed.hostname + ")", {
          code: tlsError ? "tls_error" : retryable ? "network_error" : "network_request_error",
          retryable,
        })
      );
    });
    // One wall-clock timer covers DNS, connect, headers, and body phases.
    timeoutHandle = setTimeout(() => {
      req.destroy(
        new DiscoveryError("请求超时：" + parsed.hostname, {
          code: "timeout",
          retryable: true,
        })
      );
    }, settings.timeout * 1000);
    if (settings.body !== null) req.write(settings.body);
    req.end();
  });
}

async function soapPost(url, body, args) {
  const response = await requestBytes(url, {
    method: "POST",
    body,
    timeout: args.timeout,
    insecureTls: args.insecureTls,
    allowedHosts: [FE3_HOST],
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8",
      Accept: "application/soap+xml, text/xml, */*",
    },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new DiscoveryError("FE3 返回 HTTP " + response.statusCode, {
      code: "fe3_http_error",
      stage: "fe3",
      retryable: retryableHttpStatus(response.statusCode),
      httpStatus: response.statusCode,
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  return response.body;
}

function throwIfSoapFault(root) {
  const faults = findNodes(root, "Fault");
  if (faults.length > 1) {
    throw new DiscoveryError("FE3 返回了多个 SOAP Fault", {
      code: "fe3_metadata_ambiguous",
      stage: "fe3",
    });
  }
  const fault = faults[0];
  if (!fault) return;
  const reason = (descendantText(fault, "Text") || descendantText(fault, "Reason"))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  throw new DiscoveryError("FE3 返回 SOAP Fault" + (reason ? "：" + reason : ""));
}

function soapHeader(action, target, created, device) {
  const expires = new Date(created.getTime() + 5 * 60 * 1000);
  return (
    "<s:Header>" +
    '<a:Action s:mustUnderstand="1">' +
    xmlEscape(action) +
    "</a:Action>" +
    "<a:MessageID>urn:uuid:" +
    randomUuid() +
    "</a:MessageID>" +
    '<a:To s:mustUnderstand="1">' +
    xmlEscape(target) +
    "</a:To>" +
    '<o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    '<Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
    "<Created>" +
    isoUtc(created) +
    "</Created><Expires>" +
    isoUtc(expires) +
    "</Expires></Timestamp>" +
    '<wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">' +
    '<TicketType Name="MSA" Version="1.0" Policy="MBI_SSL"><Device>' +
    xmlEscape(device) +
    "</Device></TicketType>" +
    "</wuws:WindowsUpdateTicketsToken></o:Security></s:Header>"
  );
}

function randomUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

function cookieRequest() {
  const created = nowUtc();
  const header = soapHeader(
    "http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetCookie",
    FE3_URL,
    created,
    ""
  ).replace(
    "<Device></Device>",
    '<User xmlns="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization" />'
  );
  return (
    '<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    header +
    '<s:Body><GetCookie xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">' +
    "<oldCookie /><lastChange>2015-10-21T17:01:07.1472913Z</lastChange><currentTime>" +
    isoUtc(created) +
    "</currentTime><protocolVersion>1.40</protocolVersion></GetCookie></s:Body></s:Envelope>"
  );
}

function syncRequest(cookie, categoryId, ring) {
  const created = nowUtc();
  const ids = INSTALLED_NON_LEAF_IDS.map((id) => "<int>" + id + "</int>").join("");
  const encryptedData =
    cookie && typeof cookie === "object" ? cookie.encrypted_data : String(cookie || "");
  const expiration =
    cookie && typeof cookie === "object" ? cookie.expiration : "";
  if (!encryptedData || !expiration) {
    throw new DiscoveryError("FE3 cookie 数据不完整");
  }
  const header = soapHeader(
    "http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/SyncUpdates",
    FE3_URL,
    created,
    DEVICE_TOKEN
  );
  return (
    '<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    header +
    '<s:Body><SyncUpdates xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">' +
    "<cookie><Expiration>" +
      xmlEscape(expiration) +
      "</Expiration><EncryptedData>" +
      xmlEscape(encryptedData) +
      "</EncryptedData></cookie><parameters><ExpressQuery>false</ExpressQuery>" +
    "<InstalledNonLeafUpdateIDs>" +
    ids +
    "</InstalledNonLeafUpdateIDs><OtherCachedUpdateIDs /><SkipSoftwareSync>false</SkipSoftwareSync>" +
    "<NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates><FilterAppCategoryIds>" +
    "<CategoryIdentifier><Id>" +
    xmlEscape(categoryId) +
    "</Id></CategoryIdentifier></FilterAppCategoryIds><TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>" +
    "<AlsoPerformRegularSync>false</AlsoPerformRegularSync><ComputerSpec />" +
    "<ExtendedUpdateInfoParameters><XmlUpdateFragmentTypes><XmlUpdateFragmentType>Extended</XmlUpdateFragmentType></XmlUpdateFragmentTypes></ExtendedUpdateInfoParameters>" +
    "<ProductsParameters><SyncCurrentVersionOnly>false</SyncCurrentVersionOnly><DeviceAttributes>FlightRing=" +
    xmlEscape(ring) +
    ";DeviceFamily=Windows.Desktop;</DeviceAttributes><CallerAttributes>Interactive=1;IsSeeker=0;</CallerAttributes><Products /></ProductsParameters>" +
    "</parameters></SyncUpdates></s:Body></s:Envelope>"
  );
}

function urlRequest(updateId, revision, ring) {
  const created = nowUtc();
  const header = soapHeader(
    "http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2",
    FE3_SECURED_URL,
    created,
    DEVICE_TOKEN
  );
  return (
    '<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    header +
    '<s:Body><GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">' +
    "<updateIDs><UpdateIdentity><UpdateID>" +
    xmlEscape(updateId) +
    "</UpdateID><RevisionNumber>" +
    xmlEscape(revision) +
    "</RevisionNumber></UpdateIdentity></updateIDs>" +
    "<infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType><XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType></infoTypes>" +
    "<deviceAttributes>FlightRing=" +
    xmlEscape(ring) +
    ";DeviceFamily=Windows.Desktop;</deviceAttributes></GetExtendedUpdateInfo2></s:Body></s:Envelope>"
  );
}

async function getCookie(args) {
  const root = parseXml((await soapPost(FE3_URL, cookieRequest(), args)).toString("utf8"));
  throwIfSoapFault(root);
  const encryptedDataNodes = nonEmptyDescendants(root, "EncryptedData");
  if (encryptedDataNodes.length !== 1) {
    throw new DiscoveryError("FE3 GetCookie 返回的 EncryptedData 不唯一", {
      code: "fe3_metadata_ambiguous",
      stage: "fe3_cookie",
    });
  }
  const expirationNodes = nonEmptyDescendants(root, "Expiration");
  if (expirationNodes.length !== 1) {
    throw new DiscoveryError("FE3 GetCookie 返回的 Expiration 不唯一", {
      code: "fe3_metadata_ambiguous",
      stage: "fe3_cookie",
    });
  }
  const item = encryptedDataNodes[0];
  const expiration = String(expirationNodes[0].text || "").trim();
  const expirationMs = Date.parse(expiration);
  if (!isValidTimestamp(expiration) || expirationMs <= Date.now()) {
    throw new DiscoveryError("FE3 GetCookie 未返回有效的过期时间");
  }
  return {
    encrypted_data: String(item.text || "").trim(),
    expiration,
  };
}

function requiredMetadataToken(value, label, maxLength) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 256;
  if (typeof value !== "string") {
    throw new DiscoveryError("StoreEdge " + label + " 类型无效", {
      code: "storeedge_metadata_invalid",
      stage: "storeedge",
    });
  }
  const text = value.trim();
  if (
    !text ||
    text.length > limit ||
    UNSAFE_CONTROL_RE.test(text) ||
    /\s/.test(text)
  ) {
    throw new DiscoveryError("StoreEdge " + label + " 格式无效", {
      code: "storeedge_metadata_invalid",
      stage: "storeedge",
    });
  }
  return text;
}

function optionalMetadataBytes(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new DiscoveryError("StoreEdge " + label + " 格式无效", {
      code: "storeedge_metadata_invalid",
      stage: "storeedge",
    });
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new DiscoveryError("StoreEdge " + label + " 超出安全范围", {
      code: "storeedge_metadata_invalid",
      stage: "storeedge",
    });
  }
  return number;
}

function stableFingerprint(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableFingerprint(item)).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableFingerprint(value[key]))
      .join(",") +
    "}"
  );
}

function stableListFingerprint(value) {
  if (!Array.isArray(value)) return stableFingerprint(value);
  return stableFingerprint(
    value
      .slice()
      .sort((left, right) =>
        stableFingerprint(left).localeCompare(stableFingerprint(right), "en")
      )
  );
}

function fulfillmentKey(candidate) {
  return JSON.stringify([
    candidate && candidate.PackageFamilyName !== undefined
      ? String(candidate.PackageFamilyName).trim().toLowerCase()
      : "",
    candidate && candidate.WuCategoryId !== undefined
      ? String(candidate.WuCategoryId).trim().toLowerCase()
      : "",
    candidate && candidate.WuBundleId !== undefined
      ? String(candidate.WuBundleId).trim().toLowerCase()
      : "",
  ]);
}

function ensureConsistentFulfillments(items) {
  const candidates = Array.isArray(items) ? items : [];
  if (candidates.length < 2) return;
  const keys = new Set(candidates.map((item) => fulfillmentKey(item && item.candidate)));
  if (keys.size > 1) {
    throw new DiscoveryError("StoreEdge 返回了相互冲突的 FE3 包标识", {
      code: "storeedge_ambiguous_fulfillment",
      stage: "storeedge",
    });
  }
}

async function storeedgeMetadata(productId, args) {
  const requestedProductId = String(productId || "");
  if (requestedProductId.toUpperCase() !== DEFAULT_PRODUCT_ID) {
    throw new DiscoveryError(
      "本技能只支持 ChatGPT Work/Codex 产品 ID " + DEFAULT_PRODUCT_ID
    );
  }
  const url =
    "https://" +
    STOREEDGE_HOST +
    "/v9.0/products/" +
    encodeURIComponent(requestedProductId) +
    "?market=" +
    encodeURIComponent(args.market) +
    "&locale=" +
    encodeURIComponent(args.locale) +
    "&deviceFamily=Windows.Desktop";
  const response = await requestBytes(url, {
    timeout: args.timeout,
    insecureTls: args.insecureTls,
    allowedHosts: [STOREEDGE_HOST],
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new DiscoveryError("StoreEdge 返回 HTTP " + response.statusCode, {
      code: "storeedge_http_error",
      stage: "storeedge",
      retryable: retryableHttpStatus(response.statusCode),
      httpStatus: response.statusCode,
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  let document;
  try {
    document = JSON.parse(response.body.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new DiscoveryError("StoreEdge 返回的不是有效 JSON");
  }
  const payload = document && document.Payload;
  if (!payload || typeof payload !== "object") throw new DiscoveryError("StoreEdge 响应缺少 Payload");
  if (
    !payload.ProductId ||
    String(payload.ProductId).toUpperCase() !== requestedProductId.toUpperCase()
  ) {
    throw new DiscoveryError("StoreEdge 产品 ID 不匹配");
  }
  const title = typeof payload.Title === "string" ? payload.Title.trim() : "";
  const publisher =
    typeof payload.PublisherName === "string" ? payload.PublisherName.trim() : "";
  if (title.toLowerCase() !== EXPECTED_PRODUCT_TITLE.toLowerCase()) {
    throw new DiscoveryError("StoreEdge 产品标题不是预期的 ChatGPT");
  }
  if (publisher.toLowerCase() !== EXPECTED_PUBLISHER.toLowerCase()) {
    throw new DiscoveryError("StoreEdge 发布者不是预期的 OpenAI");
  }
  const fulfillments = [];
  const metadataWarnings = [];
  const skus = Array.isArray(payload.Skus) ? payload.Skus : [];
  for (let skuIndex = 0; skuIndex < skus.length; skuIndex += 1) {
    const sku = skus[skuIndex];
    if (!sku || typeof sku !== "object" || typeof sku.FulfillmentData !== "string") {
      addMetadataWarning(
        metadataWarnings,
        "SKU " + (skuIndex + 1) + " 缺少或无效的 FulfillmentData"
      );
      continue;
    }
    let candidate;
    try {
      candidate = JSON.parse(sku.FulfillmentData);
    } catch (error) {
      addMetadataWarning(metadataWarnings, "SKU " + (skuIndex + 1) + " 的 FulfillmentData JSON 无效");
      continue;
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.WuCategoryId !== "string" ||
      typeof candidate.PackageFamilyName !== "string" ||
      !candidate.WuCategoryId.trim() ||
      !candidate.PackageFamilyName.trim() ||
      (candidate.ProductId !== undefined &&
        (typeof candidate.ProductId !== "string" ||
          candidate.ProductId.trim().toUpperCase() !== requestedProductId.toUpperCase()))
    ) {
      addMetadataWarning(metadataWarnings, "SKU " + (skuIndex + 1) + " 的 FE3 包标识字段无效");
      continue;
    }
    const skuType = String(sku.SkuType || "").toLowerCase();
    fulfillments.push({ candidate, skuType });
  }
  const exactFulfillments = fulfillments.filter(
    (item) =>
      item.candidate.PackageFamilyName.trim().toLowerCase() ===
      EXPECTED_PACKAGE_FAMILY_NAME.toLowerCase()
  );
  const fullFulfillments = fulfillments.filter((item) => item.skuType === "full");
  let selectedFulfillments = fulfillments;
  if (exactFulfillments.length) selectedFulfillments = exactFulfillments;
  else if (fullFulfillments.length) selectedFulfillments = fullFulfillments;
  ensureConsistentFulfillments(selectedFulfillments);
  const fulfillment = (selectedFulfillments[0] || {}).candidate;
  if (!fulfillment) {
    throw new DiscoveryError("StoreEdge 未返回完整的 FE3 包标识", {
      code: "storeedge_missing_fulfillment",
      stage: "storeedge",
    });
  }
  const packageFamilyName = fulfillment.PackageFamilyName.trim();
  if (packageFamilyName.toLowerCase() !== EXPECTED_PACKAGE_FAMILY_NAME.toLowerCase()) {
    throw new DiscoveryError(
      "StoreEdge PackageFamilyName 不匹配预期的 OpenAI.Codex 包"
    );
  }
  const wuCategoryId = requiredMetadataToken(
    fulfillment.WuCategoryId,
    "WuCategoryId",
    256
  );
  const wuBundleId = requiredMetadataToken(fulfillment.WuBundleId, "WuBundleId", 256);
  const lastUpdateUtc = requiredMetadataToken(
    payload.LastUpdateDateUtc,
    "LastUpdateDateUtc",
    128
  );
  if (!isValidTimestamp(lastUpdateUtc)) {
    throw new DiscoveryError("StoreEdge LastUpdateDateUtc 格式无效", {
      code: "storeedge_metadata_invalid",
      stage: "storeedge",
    });
  }
  const revisionId = requiredMetadataToken(payload.RevisionId, "RevisionId", 256);
  let platforms = [];
  if (payload.Platforms !== undefined && payload.Platforms !== null) {
    if (!Array.isArray(payload.Platforms)) {
      throw new DiscoveryError("StoreEdge Platforms 类型无效", {
        code: "storeedge_metadata_invalid",
        stage: "storeedge",
      });
    }
    platforms = payload.Platforms.map((item) => requiredMetadataToken(item, "Platforms 项", 64));
    for (const platform of platforms) {
      if (!KNOWN_STOREEDGE_PLATFORM_VALUES.has(platform.toLowerCase())) {
        throw new DiscoveryError("StoreEdge Platforms 包含未识别的架构值", {
          code: "storeedge_metadata_invalid",
          stage: "storeedge",
        });
      }
    }
  }
  return {
    product_id: requestedProductId,
    title,
    publisher,
    package_family_name: packageFamilyName,
    wu_category_id: wuCategoryId,
    wu_bundle_id: wuBundleId,
    last_update_utc: lastUpdateUtc,
    revision_id: revisionId,
    approximate_size_bytes: optionalMetadataBytes(
      payload.ApproximateSizeInBytes,
      "ApproximateSizeInBytes"
    ),
    platforms,
    metadata_warnings: metadataWarnings,
  };
}

function parseSyncUpdates(payload, packageFamily) {
  const root = parseXml(payload.toString("utf8"));
  throwIfSoapFault(root);
  const packageUpdates = new Map();
  const extendedFiles = new Map();
  // AppxMetadata PackageMoniker uses the publisher ID after the double
  // underscore (for example __2p2nqsd0c76g0), while StoreEdge exposes the
  // full package family name OpenAI.Codex_2p2nqsd0c76g0.
  const suffix = packageFamily.includes("_")
    ? packageFamily.slice(packageFamily.indexOf("_") + 1)
    : packageFamily;

  for (const info of findNodes(root, "UpdateInfo")) {
    const idNode = uniqueChildNode(
      info,
      "ID",
      "FE3 UpdateInfo 的更新 ID 缺失或重复",
      { stage: "fe3_sync" }
    );
    const outerId = String(idNode.text || "").trim();
    if (!outerId) {
      throw new DiscoveryError("FE3 UpdateInfo 缺少更新 ID", {
        code: "fe3_metadata_incomplete",
        stage: "fe3_sync",
      });
    }
    const xmlNode = uniqueChildNode(
      info,
      "Xml",
      "FE3 UpdateInfo 的 XML 元数据缺失或重复",
      { stage: "fe3_sync" }
    );
    if (!xmlNode || !String(xmlNode.text || "").trim()) {
      throw new DiscoveryError("FE3 UpdateInfo 缺少 XML 元数据", {
        code: "fe3_metadata_incomplete",
        stage: "fe3_sync",
      });
    }
    const fragment = parseFragment(xmlNode.text);
    const fragmentBody = childNode(fragment, "fragment");
    if (!fragmentBody) {
      throw new DiscoveryError("FE3 UpdateInfo XML 片段缺少根元素", {
        code: "fe3_metadata_incomplete",
        stage: "fe3_sync",
      });
    }
    const identity = uniqueChildNode(
      fragmentBody,
      "UpdateIdentity",
      "FE3 UpdateInfo 的顶层 UpdateIdentity 缺失或重复",
      { code: "fe3_metadata_ambiguous", stage: "fe3_sync" }
    );
    for (const metadata of findNodes(fragment, "AppxMetadata")) {
      const moniker = getAttr(metadata, "PackageMoniker").trim();
      if (!moniker) continue;
      const match = /^OpenAI\.Codex_(\d{1,10}(?:\.\d{1,10}){3})_(x64|arm64)__([^_\s]+)$/i.exec(
        moniker
      );
      if (!match) continue;
      if (match[3].toLowerCase() !== suffix.toLowerCase()) continue;
      if (!/^\d+$/.test(outerId)) {
        throw new DiscoveryError("FE3 目标包的 UpdateInfo/ID 不是有效数字", {
          code: "invalid_update_id",
          stage: "fe3_sync",
        });
      }
      const updateId = getAttr(identity, "UpdateID").trim();
      const revision = getAttr(identity, "RevisionNumber").trim();
      if (!updateId || !revision) {
        throw new DiscoveryError("FE3 目标包缺少 UpdateID 或 RevisionNumber", {
          code: "fe3_metadata_incomplete",
          stage: "fe3_sync",
        });
      }
      if (!/^\d+$/.test(revision)) {
        throw new DiscoveryError("FE3 目标包的 RevisionNumber 不是有效数字", {
          code: "invalid_revision_number",
          stage: "fe3_sync",
        });
      }
      // FE3 uses the numeric UpdateInfo/Update ID as the correlation key for
      // extended file metadata; UpdateIdentity@UpdateID is a separate GUID
      // used by GetExtendedUpdateInfo2. They are intentionally not equal.
      const candidate = {
        outer_id: outerId,
        update_id: updateId,
        revision,
        version: match[1],
        architecture: match[2].toLowerCase(),
        package_moniker: moniker,
      };
      // Package identity matching is case-insensitive on Windows. Normalize
      // the map key so FE3 case-only duplicates cannot bypass ambiguity checks.
      const packageKey = moniker.toLowerCase();
      const previous = packageUpdates.get(packageKey);
      if (previous) {
        const revisionComparison = compareRevisions(previous.revision, revision);
        if (
          revisionComparison === 0 &&
          (previous.outer_id !== outerId || previous.update_id !== updateId)
        ) {
          throw new DiscoveryError("FE3 为同一包返回了相互冲突的更新标识", {
            code: "ambiguous_package_update",
            stage: "fe3_sync",
          });
        }
        if (revisionComparison >= 0) continue;
      }
      packageUpdates.set(packageKey, Object.assign({}, candidate));
    }
  }

  for (const update of findNodes(root, "Update")) {
    const idNode = uniqueChildNode(
      update,
      "ID",
      "FE3 Update 的更新 ID 缺失或重复",
      { stage: "fe3_sync" }
    );
    const outerId = String(idNode.text || "").trim();
    if (!outerId) {
      throw new DiscoveryError("FE3 Update 缺少更新 ID", {
        code: "fe3_metadata_incomplete",
        stage: "fe3_sync",
      });
    }
    const xmlNode = uniqueChildNode(
      update,
      "Xml",
      "FE3 Update 的 XML 文件元数据缺失或重复",
      { stage: "fe3_sync" }
    );
    if (!xmlNode || !String(xmlNode.text || "").trim()) {
      throw new DiscoveryError("FE3 Update 缺少 XML 文件元数据", {
        code: "fe3_metadata_incomplete",
        stage: "fe3_sync",
      });
    }
    const fragment = parseFragment(xmlNode.text);
    const files = [];
    for (const fileNode of findNodes(fragment, "File")) {
      const attrs = Object.create(null);
      for (const [name, value] of Object.entries(fileNode.attrs || {})) {
        const attributeName = localName(name);
        attrs[attributeName] =
          attributeName === "FileName" ? String(value || "") : String(value || "").trim();
      }
      const additionalDigests = (fileNode.children || []).filter(
        (child) =>
          localName(child.name) === "AdditionalDigest" &&
          String(getAttr(child, "Algorithm"))
            .replace(/-/g, "")
            .toUpperCase() === "SHA256"
      );
      if (additionalDigests.length > 1) {
        throw new DiscoveryError("FE3 返回了重复的 SHA-256 文件摘要");
      }
      attrs.sha256_base64 = additionalDigests.length
        ? String(additionalDigests[0].text || "").trim()
        : "";
      files.push(attrs);
    }
    if (files.length) {
      const previousFiles = extendedFiles.get(outerId);
      if (previousFiles) {
        if (stableListFingerprint(previousFiles) !== stableListFingerprint(files)) {
          throw new DiscoveryError("FE3 为同一更新返回了相互冲突的文件信息", {
            code: "ambiguous_extended_update",
            stage: "fe3_sync",
          });
        }
        continue;
      }
      extendedFiles.set(outerId, files);
    }
  }
  return { packageUpdates, extendedFiles };
}

function findFile(packageInfo, extendedFiles) {
  if (!packageInfo.outer_id) {
    throw new DiscoveryError("FE3 包更新缺少关联的 Update ID", {
      code: "package_update_missing",
      stage: "fe3_sync",
    });
  }
  const candidates = extendedFiles.get(packageInfo.outer_id) || [];
  const matches = candidates.filter(
    (item) => {
      const digestAlgorithm = String(item.DigestAlgorithm || "")
        .replace(/[\s-]/g, "")
        .toUpperCase();
      return (
        String(item.InstallerSpecificIdentifier || "").toLowerCase() ===
          packageInfo.package_moniker.toLowerCase() &&
        !item.PatchingType &&
        item.Digest &&
        /\.msix$/i.test(String(item.FileName || "")) &&
        (!digestAlgorithm || digestAlgorithm === "SHA1")
      );
    }
  );
  if (matches.length === 0) {
    throw new DiscoveryError("FE3 未返回 " + packageInfo.package_moniker + " 的主 MSIX 文件信息", {
      code: "file_not_found",
      stage: "fe3_sync",
    });
  }
  if (matches.length > 1) {
    throw new DiscoveryError("FE3 返回了多个无法区分的主 MSIX 文件信息", {
      code: "ambiguous_file",
      stage: "fe3_sync",
    });
  }
  return matches[0];
}

function compareRevisions(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const leftBig = BigInt(a);
    const rightBig = BigInt(b);
    return leftBig < rightBig ? -1 : leftBig > rightBig ? 1 : 0;
  }
  return a.localeCompare(b, "en");
}

function normalizeCdnUrl(value) {
  const input = String(value || "");
  if (!input || UNSAFE_CONTROL_RE.test(input)) {
    throw new DiscoveryError("FE3 返回了无效的下载地址");
  }
  const raw = input.trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new DiscoveryError("FE3 返回了无效的下载地址");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_CDN_HOSTS.has(hostname) || !["http:", "https:"].includes(parsed.protocol)) {
    throw new DiscoveryError("FE3 返回了非微软允许的 CDN 地址");
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return ensureAllowedHost(parsed.toString(), Array.from(ALLOWED_CDN_HOSTS)).toString();
}

async function getFileUrl(packageInfo, fileInfo, ring, args) {
  const expectedDigest = String(fileInfo.Digest || "").trim();
  decodeBase64Digest(expectedDigest, 20, "SHA-1");
  const body = await soapPost(
    FE3_SECURED_URL,
    urlRequest(packageInfo.update_id, packageInfo.revision, ring),
    args
  );
  const root = parseXml(body.toString("utf8"));
  throwIfSoapFault(root);
  const matchingUrls = [];
  for (const location of findNodes(root, "FileLocation")) {
    const digestNodes = nonEmptyDescendants(location, "FileDigest");
    if (digestNodes.length > 1) {
      throw new DiscoveryError("FE3 FileLocation 返回了重复的 FileDigest", {
        code: "fe3_metadata_ambiguous",
        stage: "fe3_url",
      });
    }
    if (digestNodes.length === 1 && String(digestNodes[0].text || "").trim() === expectedDigest) {
      const urlNodes = nonEmptyDescendants(location, "Url");
      if (urlNodes.length !== 1) {
        throw new DiscoveryError("FE3 FileLocation 的下载 URL 缺失或重复", {
          code: "fe3_metadata_ambiguous",
          stage: "fe3_url",
        });
      }
      matchingUrls.push(normalizeCdnUrl(String(urlNodes[0].text || "").trim()));
    }
  }
  const uniqueUrls = Array.from(new Set(matchingUrls));
  if (uniqueUrls.length === 1) return uniqueUrls[0];
  if (uniqueUrls.length > 1) {
    throw new DiscoveryError(
      "FE3 为同一文件返回了多个不同的下载 URL（" + packageInfo.package_moniker + "）",
      { code: "ambiguous_download_url", stage: "fe3_url" }
    );
  }
  throw new DiscoveryError(
    "FE3 未返回与 SHA-1 摘要匹配的下载 URL（" + packageInfo.package_moniker + "）",
    { code: "url_not_found", stage: "fe3_url" }
  );
}

function headerValues(headers, name) {
  const source = headers && typeof headers === "object" ? headers : {};
  const normalizedName = String(name).toLowerCase();
  let value = source[normalizedName];
  if (value === undefined) {
    const matchingKey = Object.keys(source).find(
      (key) => String(key).toLowerCase() === normalizedName
    );
    if (matchingKey !== undefined) value = source[matchingKey];
  }
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function headerValue(headers, name) {
  return headerValues(headers, name).join(", ");
}


const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function splitHeaderValue(value, separator) {
  const text = String(value || "");
  const parts = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"') quote = character;
    else if (character === separator) {
      const part = text.slice(start, index).trim();
      if (!part) throw new DiscoveryError("CDN Content-Disposition 参数语法无效");
      parts.push(part);
      start = index + 1;
    }
  }
  if (quote || escaped) throw new DiscoveryError("CDN Content-Disposition 引号未闭合");
  const last = text.slice(start).trim();
  if (!last) throw new DiscoveryError("CDN Content-Disposition 参数语法无效");
  parts.push(last);
  return parts;
}

function dispositionValue(value) {
  const text = String(value || "").trim();
  if (!text) throw new DiscoveryError("CDN Content-Disposition 文件名为空");
  if (UNSAFE_CONTROL_RE.test(text)) {
    throw new DiscoveryError("CDN Content-Disposition 参数值含有控制字符");
  }
  const quote = text[0];
  if (quote === '"') {
    if (text.length < 2 || text[text.length - 1] !== quote) {
      throw new DiscoveryError("CDN Content-Disposition 引号未闭合");
    }
    let decoded = "";
    let escaped = false;
    for (let index = 1; index < text.length - 1; index += 1) {
      const character = text[index];
      if (escaped) {
        decoded += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        throw new DiscoveryError("CDN Content-Disposition 引号位置无效");
      } else {
        decoded += character;
      }
    }
    if (escaped) throw new DiscoveryError("CDN Content-Disposition 转义无效");
    return decoded;
  }
  // Unquoted values cannot contain a comma: Node may combine duplicate
  // Content-Disposition lines with a comma, while a legal comma in a filename
  // is protected by quotes.
  if (!/^[^;\s,"]+$/.test(text)) {
    throw new DiscoveryError("CDN Content-Disposition 参数值无效");
  }
  return text;
}

function decodeDispositionFilenameStar(value) {
  const text = dispositionValue(value);
  const match = /^([^']*)'([^']*)'(.*)$/.exec(text);
  if (!match || String(match[1]).toLowerCase() !== "utf-8") {
    throw new DiscoveryError("CDN Content-Disposition 文件名编码无效");
  }
  try {
    return decodeURIComponent(match[3]);
  } catch (error) {
    throw new DiscoveryError("CDN Content-Disposition 文件名编码无效");
  }
}

function parseDispositionField(value) {
  const sections = splitHeaderValue(value, ";");
  const disposition = sections.shift();
  if (!HTTP_TOKEN_RE.test(disposition)) {
    throw new DiscoveryError("CDN Content-Disposition 类型无效");
  }
  const names = [];
  for (const section of sections) {
    const equals = section.indexOf("=");
    if (equals <= 0) throw new DiscoveryError("CDN Content-Disposition 参数语法无效");
    const parameter = section.slice(0, equals).trim().toLowerCase();
    if (!HTTP_TOKEN_RE.test(parameter)) {
      throw new DiscoveryError("CDN Content-Disposition 参数名无效");
    }
    const rawValue = section.slice(equals + 1).trim();
    if (parameter === "filename*") names.push(decodeDispositionFilenameStar(rawValue));
    else if (parameter === "filename") names.push(dispositionValue(rawValue));
    else dispositionValue(rawValue);
  }
  return names;
}

function headerFilenameCandidates(headers) {
  const values = headerValues(headers, "content-disposition");
  if (!values.length) return [];
  const names = [];
  let fieldCount = 0;
  let fieldWithoutFilename = false;
  for (const value of values) {
    // Split duplicate field lines only outside quoted values. This preserves a
    // valid filename such as "Package,arm64.Msix".
    const fields = splitHeaderValue(value, ",");
    for (const field of fields) {
      const fieldNames = parseDispositionField(field);
      fieldCount += 1;
      if (!fieldNames.length) fieldWithoutFilename = true;
      names.push(...fieldNames);
    }
  }
  if (fieldCount > 1 && fieldWithoutFilename) {
    throw new DiscoveryError("CDN Content-Disposition 重复字段无法核对文件名");
  }
  return names.map((name) =>
    validateWindowsFilename(name, "CDN Content-Disposition 文件名无效")
  );
}

function sameFilename(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function filenameCandidates(expectedFilename) {
  const values = Array.isArray(expectedFilename) ? expectedFilename : [expectedFilename];
  return values
    .map((value) => String(value === undefined || value === null ? "" : value))
    .filter((value) => value.length > 0)
    .map((value) => validateWindowsFilename(value, "FE3 返回了无效文件名"));
}

function validateProbeResponse(response, method, expectedSize, expectedFilename) {
  const status = Number(response.statusCode || 0);
  if (method === "HEAD") {
    if (status < 200 || status >= 300 || status === 204) {
      throw new DiscoveryError("HEAD 返回 HTTP " + status, {
        code: "cdn_http_error",
        stage: "cdn_probe",
        retryable: retryableHttpStatus(status),
        httpStatus: status,
        retryAfterMs: retryAfterMs(response.headers),
      });
    }
  } else if (![200, 206].includes(status)) {
    throw new DiscoveryError("Range GET 返回 HTTP " + status, {
      code: "cdn_http_error",
      stage: "cdn_probe",
      retryable: retryableHttpStatus(status),
      httpStatus: status,
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  const rawLength = headerValue(response.headers, "content-length").trim();
  if (!/^\d+$/.test(rawLength)) {
    throw new DiscoveryError("CDN Content-Length 缺失或格式无效");
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength)) {
    throw new DiscoveryError("CDN Content-Length 超出安全范围");
  }
  const contentRange = headerValue(response.headers, "content-range").trim();
  let rangeStart = null;
  let rangeEnd = null;
  let totalLength = null;
  if (contentRange) {
    const rangeMatch = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
    if (!rangeMatch) throw new DiscoveryError("CDN Content-Range 格式无效");
    rangeStart = Number(rangeMatch[1]);
    rangeEnd = Number(rangeMatch[2]);
    totalLength = Number(rangeMatch[3]);
    if (![rangeStart, rangeEnd, totalLength].every(Number.isSafeInteger)) {
      throw new DiscoveryError("CDN Content-Range 超出安全范围");
    }
  }
  if (method === "HEAD" && contentLength !== expectedSize) {
    throw new DiscoveryError(
      "CDN 文件大小不匹配：FE3=" + expectedSize + "，CDN=" + contentLength
    );
  }
  if (method === "GET-range") {
    if (!response.body || response.body.length !== 1) {
      throw new DiscoveryError("CDN Range 响应未返回首字节");
    }
    if (status === 206) {
      if (
        rangeStart !== 0 ||
        rangeEnd !== 0 ||
        totalLength === null ||
        totalLength !== expectedSize
      ) {
        throw new DiscoveryError(
          "CDN Content-Range 不匹配：期望 bytes 0-0/" +
            expectedSize + "，实际=" + (contentRange || "缺失")
        );
      }
      if (contentLength !== 1) {
        throw new DiscoveryError("CDN Range 响应长度不匹配");
      }
    } else if (contentLength !== expectedSize) {
      throw new DiscoveryError(
        "CDN Range 回退返回完整响应但大小不匹配：FE3=" + expectedSize + "，CDN=" +
          contentLength
      );
    }
  }
  const cdnFilenames = headerFilenameCandidates(response.headers);
  const expectedNames = filenameCandidates(expectedFilename);
  if (cdnFilenames.length && !expectedNames.length) {
    throw new DiscoveryError("CDN Content-Disposition 文件名无法核对");
  }
  if (cdnFilenames.length) {
    const mismatchedFilename = cdnFilenames.find(
      (actual) => !expectedNames.some((candidate) => sameFilename(actual, candidate))
    );
    if (mismatchedFilename) {
      throw new DiscoveryError(
        "CDN Content-Disposition 文件名不匹配：期望 " +
          expectedNames.join(" 或 ") +
          "，实际 " +
          cdnFilenames.join(" 或 ")
      );
    }
    const firstFilename = cdnFilenames[0];
    if (cdnFilenames.some((actual) => !sameFilename(actual, firstFilename))) {
      throw new DiscoveryError(
        "CDN Content-Disposition 返回了相互冲突的文件名：" +
          cdnFilenames.join(" 或 ")
      );
    }
  }
  const cdnFilename = cdnFilenames[0] || "";
  return {
    content_length: contentLength,
    total_length: totalLength,
    content_range: contentRange,
    cdn_filename: cdnFilename,
  };
}

async function probeUrl(urlOrFactory, expectedSize, expectedFilename, args) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new DiscoveryError("FE3 返回了无效文件大小");
  }
  const getUrl =
    typeof urlOrFactory === "function" ? urlOrFactory : async () => String(urlOrFactory || "");
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_URL_PROBE_ATTEMPTS; attempt += 1) {
    let url = "";
    try {
      // Re-fetch the FE3 URL on every retry. Signed CDN URLs are short-lived and
      // a transient edge response must not cause us to reuse a stale signature.
      url = await getUrl();
      if (!url) {
        throw new DiscoveryError("未生成有效的下载地址", {
          code: "missing_download_url",
          stage: "fe3",
        });
      }
      let response;
      let method = "HEAD";
      response = await requestBytes(url, {
        method: "HEAD",
        timeout: args.timeout,
        insecureTls: args.insecureTls,
        allowedHosts: Array.from(ALLOWED_CDN_HOSTS),
        captureBody: false,
      });
      const headStatus = Number(response.statusCode || 0);
      const rawHeadLength = headerValue(response.headers, "content-length").trim();
      const headLength = Number(rawHeadLength);
      const headLengthValid =
        /^\d+$/.test(rawHeadLength) &&
        Number.isSafeInteger(headLength) &&
        headLength > 0;
      const headShouldFallback =
        HEAD_FALLBACK_STATUSES.has(headStatus) ||
        (headStatus >= 200 && headStatus < 300 && !headLengthValid);
      if (!headShouldFallback) {
        const checked = validateProbeResponse(response, method, expectedSize, expectedFilename);
        return {
          source_url: url,
          probe_attempts: attempt,
          url_verified: true,
          probe_method: method,
          http_status: response.statusCode,
          resolved_url: response.url,
          url_checked_at_utc: isoUtc(nowUtc()),
          content_length: checked.content_length,
          content_range: checked.content_range,
          content_type: sanitizeHeaderValue(headerValue(response.headers, "content-type")),
          content_disposition: sanitizeHeaderValue(
            headerValue(response.headers, "content-disposition")
          ),
          cdn_filename: checked.cdn_filename,
          last_modified: sanitizeHeaderValue(headerValue(response.headers, "last-modified")),
          etag: sanitizeHeaderValue(headerValue(response.headers, "etag")),
          tls_verified: !args.insecureTls,
        };
      }
      method = "GET-range";
      response = await requestBytes(url, {
        method: "GET",
        timeout: args.timeout,
        insecureTls: args.insecureTls,
        allowedHosts: Array.from(ALLOWED_CDN_HOSTS),
        headers: { Range: "bytes=0-0" },
        captureBody: true,
        capturePrefixBytes: 1,
      });
      const checked = validateProbeResponse(response, method, expectedSize, expectedFilename);
      return {
        source_url: url,
        probe_attempts: attempt,
        url_verified: true,
        probe_method: method,
        http_status: response.statusCode,
        resolved_url: response.url,
        url_checked_at_utc: isoUtc(nowUtc()),
        content_length: checked.content_length,
        content_range: checked.content_range,
        content_type: sanitizeHeaderValue(headerValue(response.headers, "content-type")),
        content_disposition: sanitizeHeaderValue(
          headerValue(response.headers, "content-disposition")
        ),
        cdn_filename: checked.cdn_filename,
        last_modified: sanitizeHeaderValue(headerValue(response.headers, "last-modified")),
        etag: sanitizeHeaderValue(headerValue(response.headers, "etag")),
        tls_verified: !args.insecureTls,
      };
    } catch (error) {
      const normalized = annotateError(error, {
        code: "cdn_probe_error",
        stage: "cdn_probe",
        retryable: false,
      });
      normalized.attempts = attempt;
      lastError = normalized;
      if (attempt >= MAX_URL_PROBE_ATTEMPTS || normalized.retryable !== true) {
        throw normalized;
      }
      const waitMs =
        Number.isSafeInteger(normalized.retry_after_ms) && normalized.retry_after_ms > 0
          ? Math.min(normalized.retry_after_ms, MAX_RETRY_AFTER_MS)
          : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS);
      await sleep(waitMs);
    }
  }
  throw lastError || new DiscoveryError("CDN 探针失败", { code: "cdn_probe_error", stage: "cdn_probe" });
}

function decodeBase64Digest(value, expectedBytes, label) {
  const encoded = String(value || "").trim();
  const pattern = expectedBytes === 20 ? /^[A-Za-z0-9+/]{27}=$/ : /^[A-Za-z0-9+/]{43}=$/;
  if (!pattern.test(encoded)) {
    throw new DiscoveryError("FE3 返回了无效的 " + label + " 摘要");
  }
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length !== expectedBytes || decoded.toString("base64") !== encoded) {
      throw new Error("length or canonical encoding mismatch");
    }
    return decoded;
  } catch (error) {
    throw new DiscoveryError("FE3 返回了无效的 " + label + " 摘要");
  }
}

function isCanonicalBase64(value) {
  const encoded = String(value || "");
  if (
    !encoded ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return false;
  }
  try {
    return Buffer.from(encoded, "base64").toString("base64") === encoded;
  } catch (error) {
    return false;
  }
}

function sha256Hex(value) {
  return decodeBase64Digest(value, 32, "SHA-256").toString("hex");
}

function versionParts(version) {
  return String(version)
    .split(/[.-]/)
    .map((part) => (/^\d+$/.test(part) ? BigInt(part) : part));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    // Keep the source parseable on runtimes old enough to need the explicit
    // Node.js version error below; BigInt literals would fail before it runs.
    const x = a[index] === undefined ? BigInt(0) : a[index];
    const y = b[index] === undefined ? BigInt(0) : b[index];
    if (typeof x === "bigint" && typeof y === "bigint") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const comparison = String(x).localeCompare(String(y), "en");
      if (comparison !== 0) return comparison;
    }
  }
  return 0;
}

function makeArtifact(packageInfo, fileInfo, url, probe) {
  if (!/^\d+$/.test(String(fileInfo.Size || ""))) {
    throw new DiscoveryError("FE3 未返回有效文件大小");
  }
  const size = Number(fileInfo.Size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new DiscoveryError("FE3 返回的文件大小超出安全范围");
  }
  const sha1 = String(fileInfo.Digest || "").trim();
  decodeBase64Digest(sha1, 20, "SHA-1");
  const sha256 = sha256Hex(fileInfo.sha256_base64 || "");
  const modifiedUtc = String(fileInfo.Modified || "").trim();
  if (
    !modifiedUtc ||
    UNSAFE_CONTROL_RE.test(modifiedUtc) ||
    !isValidTimestamp(modifiedUtc)
  ) {
    throw new DiscoveryError("FE3 未返回有效文件修改时间", {
      code: "invalid_file_metadata",
      stage: "fe3_sync",
    });
  }
  const expectedFilenameValue =
    fileInfo.FileName === undefined || fileInfo.FileName === null || fileInfo.FileName === ""
      ? packageInfo.package_moniker + ".Msix"
      : String(fileInfo.FileName);
  const expectedFilename = validateWindowsFilename(expectedFilenameValue, "FE3 返回了无效文件名");
  return Object.assign(
    {
      architecture: packageInfo.architecture,
      version: packageInfo.version,
      package_moniker: packageInfo.package_moniker,
      file_name: probe.cdn_filename || expectedFilename,
      url,
      resolved_url: probe.resolved_url || "",
      size_bytes: size,
      sha256,
      sha1_base64: sha1,
      modified_utc: modifiedUtc,
      verification_scope: "storeedge_fe3_metadata_and_cdn_probe",
      hash_source: "FE3",
      local_hash_verified: false,
      downloaded: false,
      tls_verified: probe.tls_verified === true,
    },
    probe
  );
}

function parseArgs(argv) {
  const args = {
    productId: DEFAULT_PRODUCT_ID,
    market: "US",
    locale: "en-us",
    ring: "Retail",
    arch: "x64",
    timeout: 45,
    json: false,
    redactUrl: false,
    insecureTls: DEFAULT_INSECURE_TLS,
    tlsMode: DEFAULT_INSECURE_TLS ? "insecure" : "strict",
  };
  let tlsMode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    if (item === "--json") {
      args.json = true;
      continue;
    }
    if (item === "--redact-url") {
      args.redactUrl = true;
      continue;
    }
    if (item === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (item === "--strict-tls") {
      if (tlsMode === "insecure") {
        args.tlsMode = "conflict";
        throw new DiscoveryError("--strict-tls 与 --insecure-tls 不能同时使用", {
          code: "conflicting_tls_mode",
          stage: "arguments",
          tlsMode: "conflict",
        });
      }
      tlsMode = "strict";
      args.insecureTls = false;
      args.tlsMode = "strict";
      continue;
    }
    if (item === "--insecure-tls") {
      if (tlsMode === "strict") {
        args.tlsMode = "conflict";
        throw new DiscoveryError("--strict-tls 与 --insecure-tls 不能同时使用", {
          code: "conflicting_tls_mode",
          stage: "arguments",
          tlsMode: "conflict",
        });
      }
      tlsMode = "insecure";
      args.insecureTls = true;
      args.tlsMode = "insecure";
      continue;
    }
    const match = /^--(product-id|market|locale|ring|arch|timeout)=(.*)$/.exec(item);
    if (match) {
      if (match[2] === "") {
        throw new DiscoveryError("--" + match[1] + " 缺少参数值", {
          code: "missing_argument_value",
          stage: "arguments",
        });
      }
      assignArg(args, match[1], match[2]);
      continue;
    }
    const keyMatch = /^--(product-id|market|locale|ring|arch|timeout)$/.exec(item);
    if (keyMatch) {
      const next = argv[index + 1];
      if (index + 1 >= argv.length || isOptionToken(next)) {
        throw new DiscoveryError(item + " 缺少参数值", {
          code: "missing_argument_value",
          stage: "arguments",
        });
      }
      index += 1;
      assignArg(args, keyMatch[1], argv[index]);
      continue;
    }
    throw new DiscoveryError("未知参数：" + item, {
      code: "unknown_argument",
      stage: "arguments",
    });
  }
  args.arch = String(args.arch).toLowerCase();
  if (!["x64", "arm64", "both"].includes(args.arch)) {
    throw new DiscoveryError("--arch 只能是 x64、arm64 或 both", {
      code: "invalid_architecture",
      stage: "arguments",
    });
  }
  if (!Number.isFinite(args.timeout)) {
    throw new DiscoveryError("--timeout 必须是数字，范围为 1-300 秒", {
      code: "invalid_timeout",
      stage: "arguments",
    });
  }
  if (args.timeout < 1) {
    throw new DiscoveryError("--timeout 必须至少为 1 秒", {
      code: "invalid_timeout",
      stage: "arguments",
    });
  }
  if (args.timeout > 300) {
    throw new DiscoveryError("--timeout 不能超过 300 秒", {
      code: "invalid_timeout",
      stage: "arguments",
    });
  }
  if (!/^[A-Za-z0-9]{4,32}$/.test(args.productId)) {
    throw new DiscoveryError("--product-id 必须是 4-32 位字母或数字", {
      code: "invalid_product_id",
      stage: "arguments",
    });
  }
  args.productId = String(args.productId).toUpperCase();
  if (String(args.productId).toUpperCase() !== DEFAULT_PRODUCT_ID) {
    throw new DiscoveryError(
      "--product-id 必须是 ChatGPT Work/Codex 产品 ID " + DEFAULT_PRODUCT_ID,
      { code: "unsupported_product", stage: "arguments" }
    );
  }
  for (const [name, value] of [
    ["--market", args.market],
    ["--locale", args.locale],
    ["--ring", args.ring],
  ]) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(value))) {
      throw new DiscoveryError(name + " 含有无效字符", {
        code: "invalid_argument",
        stage: "arguments",
      });
    }
  }
  return args;
}

function isOptionToken(value) {
  // A negative numeric timeout is a value and should reach the range check;
  // option names (including -h) are treated as a missing value instead.
  const text = String(value === undefined || value === null ? "" : value);
  return text.startsWith("--") || /^-[A-Za-z]/.test(text);
}

function initialCliState(argv) {
  const values = Array.isArray(argv) ? argv : [];
  const hasStrictTls = values.includes("--strict-tls");
  const hasInsecureTls = values.includes("--insecure-tls");
  return {
    json: values.includes("--json"),
    insecureTls: hasStrictTls ? false : DEFAULT_INSECURE_TLS || hasInsecureTls,
    tlsMode: hasStrictTls && hasInsecureTls
      ? "conflict"
      : hasStrictTls
        ? "strict"
        : "insecure",
  };
}

function assignArg(args, key, value) {
  if (key === "product-id") args.productId = value;
  else if (key === "market") args.market = value;
  else if (key === "locale") args.locale = value;
  else if (key === "ring") args.ring = value;
  else if (key === "arch") args.arch = value;
  else if (key === "timeout") args.timeout = Number(value);
}

function usage() {
  return [
    "用法：node fetch_links.js [选项]",
    "",
    "选项：",
    "  --product-id ID          StoreEdge 产品 ID（固定为 9PLM9XGG6VKS）",
    "  --arch x64|arm64|both   目标架构，默认 x64",
    "  --market US             StoreEdge 市场，默认 US",
    "  --locale en-us          StoreEdge 语言，默认 en-us",
    "  --ring Retail           FE3 通道，默认 Retail",
    "  --timeout 45            单次请求超时秒数（1-300）",
    "  --json                  输出 JSON",
    "  --redact-url            隐藏输出中的临时签名查询参数（仍保留主机和路径）",
    "  --self-test             运行离线回归自测（不访问网络、不读写磁盘）",
    "  --insecure-tls          跳过 TLS 证书校验（默认，仅兼容性/诊断）",
    "  --strict-tls            启用 TLS 证书校验",
    "  --help                  显示帮助",
    "",
    "说明：仅发现并校验微软官方临时直链，不下载完整文件、不安装应用；各可恢复请求阶段最多尝试 3 次，每个请求最多跟随 5 次重定向。",
    "运行环境：需要 Node.js 14+。Linux/macOS 使用 NVM 等版本管理器时，请在 bash/zsh 中先加载对应环境（例如 . \"${NVM_DIR:-$HOME/.nvm}/nvm.sh\" && nvm use default）；Windows CMD/PowerShell 请先确认 node --version 可用。",
  ].join("\n");
}

function detectRuntimeEnvironment(options) {
  const values = options && typeof options === "object" ? options : {};
  const hasExplicitOptions = options !== undefined && options !== null;
  const platform = String(
    values.platform === undefined ? process.platform : values.platform || "unknown"
  ).toLowerCase();
  const hostArchitecture = String(
    values.architecture === undefined ? process.arch : values.architecture || "unknown"
  ).toLowerCase();
  const nodeVersion = String(
    values.nodeVersion === undefined
      ? process.versions && process.versions.node
      : values.nodeVersion || "unknown"
  );
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const executablePath = String(
    values.execPath === undefined ? process.execPath || "" : values.execPath || ""
  )
    .replace(/\\/g, "/")
    .toLowerCase();
  const environmentVariables =
    values.environment && typeof values.environment === "object"
      ? values.environment
      : process.env || {};
  // WSL can omit WSL_* variables in non-login SSH, service, and scheduled
  // task environments. Only probe the host kernel for real runtime calls;
  // synthetic self-test options stay deterministic and do not inspect host
  // state. Callers may provide kernelRelease explicitly for testing.
  const kernelRelease =
    values.kernelRelease === undefined
      ? hasExplicitOptions
        ? ""
        : safeKernelRelease()
      : String(values.kernelRelease || "");
  const wslKernelMarker =
    platform === "linux" && /(?:microsoft|wsl)/i.test(kernelRelease);
  const environment =
    platform === "win32"
      ? "windows"
      : platform === "linux" &&
          (environmentVariables.WSL_INTEROP ||
            environmentVariables.WSL_DISTRO_NAME ||
            environmentVariables.WSLENV ||
            wslKernelMarker)
        ? "wsl"
        : platform === "linux"
          ? "linux"
          : platform === "darwin"
            ? "macos"
            : "other";
  let nodeSource = "path-or-unknown";
  // Prefer the executable path. Manager variables can remain exported after
  // a shell switches back to a system Node.js, which should not be reported
  // as a manager-owned runtime.
  if (/(?:^|\/)nvm(?:-windows)?(?:\/|$)/.test(executablePath)) {
    nodeSource = platform === "win32" ? "nvm-windows" : "nvm";
  } else if (/(?:^|\/)\.nvm(?:\/|$)/.test(executablePath)) {
    nodeSource = "nvm";
  } else if (/(?:^|\/)(?:\.volta|volta)(?:\/|$)/.test(executablePath)) {
    nodeSource = "volta";
  } else if (/(?:^|\/)\.asdf(?:\/|$)/.test(executablePath)) {
    nodeSource = "asdf";
  } else if (/(?:^|\/)(?:\.local\/share\/mise|\.mise)(?:\/|$)/.test(executablePath)) {
    nodeSource = "mise";
  } else if (/(?:^|\/)\.nodenv(?:\/|$)/.test(executablePath)) {
    nodeSource = "nodenv";
  } else if (
    /(?:^|\/)(?:\.fnm|fnm_multishells|\.local\/share\/fnm)(?:\/|$)/.test(executablePath)
  ) {
    nodeSource = "fnm";
  } else if (/(?:^|\/)nvs(?:\/|$)/.test(executablePath)) {
    nodeSource = "nvs";
  } else if (/(?:^|\/)(?:n\/versions|\.local\/n\/versions)(?:\/|$)/.test(executablePath)) {
    nodeSource = "n";
  } else if (
    platform === "win32"
      ? /(?:^|\/)(?:program files|program files \(x86\)|appdata\/local\/programs)\/nodejs(?:\/|$)/.test(executablePath)
      : /(?:^|\/)(?:usr\/local|usr|opt\/homebrew)\/(?:bin|opt\/node(?:@[^/]+)?\/bin)\/(?:node|nodejs)$/.test(executablePath)
  ) {
    nodeSource = "system";
  } else if (environmentVariables.NVM_HOME) {
    nodeSource = "nvm-windows";
  } else if (environmentVariables.NVM_DIR) {
    nodeSource = "nvm";
  } else if (environmentVariables.VOLTA_HOME) {
    nodeSource = "volta";
  } else if (environmentVariables.ASDF_DIR || environmentVariables.ASDF_DATA_DIR) {
    nodeSource = "asdf";
  } else if (environmentVariables.MISE_DATA_DIR || environmentVariables.MISE_BIN) {
    nodeSource = "mise";
  } else if (environmentVariables.NODENV_ROOT) {
    nodeSource = "nodenv";
  } else if (environmentVariables.FNM_DIR) {
    nodeSource = "fnm";
  } else if (environmentVariables.NVS_HOME) {
    nodeSource = "nvs";
  } else if (environmentVariables.N_PREFIX) {
    nodeSource = "n";
  }
  return {
    environment,
    platform,
    host_architecture: hostArchitecture,
    node_version: nodeVersion,
    node_major: Number.isSafeInteger(nodeMajor) ? nodeMajor : null,
    node_source_hint: nodeSource,
    supported_platform: ["darwin", "linux", "win32"].includes(platform),
  };
}

function runtimeEnvironment() {
  return detectRuntimeEnvironment();
}

function attachRuntimeEnvironment(result) {
  if (!result || typeof result !== "object") return result;
  result.runtime = runtimeEnvironment();
  return result;
}

function ensureSupportedNodeVersion() {
  const major = Number(String(process.versions.node || "").split(".")[0]);
  if (!Number.isInteger(major) || major < 14) {
    throw new DiscoveryError(
      "需要 Node.js 14 或更高版本；当前版本为 " +
        (process.versions.node || "未知"),
      { code: "unsupported_node", stage: "runtime" }
    );
  }
}

function tlsVerifiedForResult(args, ok) {
  // This is a conservative result-level claim: a partial or failed result
  // never advertises TLS verification even when one architecture succeeded.
  return Boolean(
    args &&
      args.insecureTls === false &&
      args.tlsMode !== "conflict" &&
      ok === true
  );
}

function tlsStatusForArgs(args) {
  const value = args && typeof args === "object" ? args : {};
  const mode = value.tlsMode || (value.insecureTls === false ? "strict" : "insecure");
  if (mode === "conflict") {
    return {
      tls_mode: "conflict",
      tls_verification_enabled: false,
      tls_verified: false,
      security_warning: "TLS 参数冲突，未执行网络请求。",
    };
  }
  const insecure = mode !== "strict";
  return {
    tls_mode: insecure ? "insecure" : "strict",
    tls_verification_enabled: !insecure,
    tls_verified: false,
    security_warning: insecure ? INSECURE_TLS_WARNING : "",
  };
}

function tlsFieldsForResult(args, ok) {
  const status = tlsStatusForArgs(args);
  status.tls_verified = tlsVerifiedForResult(args, ok);
  return status;
}

async function run(args) {
  if (!isCanonicalBase64(DEVICE_TOKEN)) {
    throw new DiscoveryError("Skill 内置的 FE3 设备令牌未配置", {
      code: "skill_configuration_error",
      stage: "configuration",
    });
  }
  const meta = await withStage(
    () =>
      retryOperation(
        () => storeedgeMetadata(args.productId, args),
        { code: "storeedge_error", stage: "storeedge", retryable: false }
      ),
    { code: "storeedge_error", stage: "storeedge", retryable: false }
  );
  const supported = new Set(
    meta.platforms
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  const requested = args.arch === "both" ? ["x64", "arm64"] : [args.arch];
  const errors = [];
  const eligible = [];
  for (const architecture of requested) {
    // "neutral" means StoreEdge did not constrain the product to one CPU
    // architecture; FE3 still has to return and validate the requested
    // architecture-specific package before it can succeed.
    if (
      supported.size &&
      !supported.has(architecture.toLowerCase()) &&
      !supported.has("neutral")
    ) {
      const error = new DiscoveryError("StoreEdge 不声明支持 " + architecture + " 架构", {
        code: "unsupported_architecture",
        stage: "storeedge",
        architecture,
      });
      if (args.arch !== "both") throw error;
      errors.push(errorObject(error));
      continue;
    }
    eligible.push(architecture);
  }
  if (!eligible.length) {
    const tls = tlsFieldsForResult(args, false);
    return {
      checked_at_utc: isoUtc(nowUtc()),
      ok: false,
      ...tls,
      market: args.market,
      locale: args.locale,
      ring: args.ring,
      product: meta,
      artifacts: [],
      errors,
      verification_scope: "storeedge_fe3_metadata_and_cdn_probe",
      security_warning: args.insecureTls ? INSECURE_TLS_WARNING : "",
    };
  }
  const cookie = await withStage(
    () =>
      retryOperation(
        () => getCookie(args),
        { code: "fe3_cookie_error", stage: "fe3_cookie", retryable: false }
      ),
    { code: "fe3_cookie_error", stage: "fe3_cookie", retryable: false }
  );
  const syncBody = await withStage(
    () =>
      retryOperation(
        () =>
          soapPost(
            FE3_URL,
            syncRequest(cookie, meta.wu_category_id, args.ring),
            args
          ),
        { code: "fe3_sync_error", stage: "fe3_sync", retryable: false }
      ),
    { code: "fe3_sync_error", stage: "fe3_sync", retryable: false }
  );
  const parsed = await withStage(
    () => parseSyncUpdates(syncBody, meta.package_family_name),
    { code: "fe3_parse_error", stage: "fe3_sync", retryable: false }
  );
  const artifacts = [];
  for (const architecture of eligible) {
    try {
      const matching = Array.from(parsed.packageUpdates.values())
        .filter((item) => item.architecture === architecture)
        .sort((left, right) => compareVersions(right.version, left.version));
      if (!matching.length) {
        throw new DiscoveryError(
          "FE3 未返回 " + architecture + " 架构的最新 OpenAI.Codex 包",
          {
            code: "package_not_found",
            stage: "fe3_sync",
            architecture,
            retryable: false,
          }
        );
      }
      const packageInfo = matching[0];
      const fileInfo = findFile(packageInfo, parsed.extendedFiles);
      const expectedFilename = [
        fileInfo.FileName,
        packageInfo.package_moniker + ".Msix",
        packageInfo.package_moniker + ".msix",
      ];
      const probe = await probeUrl(
        () =>
          withStage(
            () => getFileUrl(packageInfo, fileInfo, args.ring, args),
            { code: "fe3_url_error", stage: "fe3_url", retryable: false }
          ),
        Number(fileInfo.Size),
        expectedFilename,
        args
      );
      artifacts.push(makeArtifact(packageInfo, fileInfo, probe.source_url, probe));
    } catch (error) {
      const normalized = annotateError(error, {
        code: "architecture_failed",
        stage: "architecture",
        architecture,
      });
      normalized.architecture = architecture;
      errors.push(errorObject(normalized));
      if (args.arch !== "both") throw normalized;
    }
  }
  const ok = errors.length === 0 && artifacts.length === eligible.length;
  const tls = tlsFieldsForResult(args, ok);
  return {
    checked_at_utc: isoUtc(nowUtc()),
    ok,
    ...tls,
    market: args.market,
    locale: args.locale,
    ring: args.ring,
    product: meta,
    artifacts,
    errors,
    verification_scope: "storeedge_fe3_metadata_and_cdn_probe",
    security_warning: args.insecureTls ? INSECURE_TLS_WARNING : "",
  };
}

function terminalText(value, fallback, maxLength) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 4096;
  const cleaned = String(value === undefined || value === null ? "" : value)
    .replace(ANSI_ESCAPE_RE, "")
    .replace(UNSAFE_CONTROL_GLOBAL_RE, " ")
    .trim();
  if (!cleaned) return fallback || "";
  return cleaned.length > limit ? cleaned.slice(0, limit) + "..." : cleaned;
}

function nextActionForError(error) {
  const code = error && error.code ? String(error.code) : "";
  if (code === "tls_error") {
    return "严格 TLS 校验失败；检查系统时间、根证书和 NODE_EXTRA_CA_CERTS，或使用默认兼容模式并接受安全警告。";
  }
  if (code === "unsupported_node") {
    return "确认当前 shell 已加载 Node.js 14 或更高版本；若使用 NVM、nvm-windows、Volta、asdf、mise、nodenv、fnm 或 nvs，请先初始化对应环境，再运行 node --version。";
  }
  if (code === "invalid_architecture") {
    return "将 --arch 设置为 x64、arm64 或 both，并确认目标 Windows 设备架构。";
  }
  if (code === "unsupported_architecture") return "确认目标 Windows 设备架构，并使用 --arch x64 或 --arch arm64。";
  if (code === "package_not_found") return "重新查询 StoreEdge/FE3，并确认市场、语言和 Retail 通道。";
  if (code === "storeedge_metadata_invalid") {
    return "重新查询 StoreEdge；若关键字段持续缺失，检查市场、语言或接口响应格式。";
  }
  if (code === "storeedge_error") {
    return "检查 StoreEdge 产品身份和响应格式；若是网络错误，稍后重新运行脚本。";
  }
  if (code === "storeedge_missing_fulfillment") {
    return "StoreEdge 未返回 FE3 包标识；检查市场、语言和产品 ID 后重新查询。";
  }
  if (code === "storeedge_ambiguous_fulfillment") {
    return "StoreEdge 返回了冲突的包标识；不要手工拼接结果，稍后重新查询并保留原始错误。";
  }
  if (code === "cdn_http_error" && Number(error && error.http_status) === 403) {
    return "CDN 返回 HTTP 403；临时签名可能已过期，或当前网络出口/目标架构被边缘节点拒绝。重新查询获取新 URL，不要手工拼接或复用旧地址。";
  }
  if (
    code === "cdn_http_error" ||
    code === "cdn_probe_error" ||
    code === "network_error" ||
    code === "timeout"
  ) {
    return "检查网络、DNS 和防火墙；临时签名 URL 失效时重新运行脚本。";
  }
  if (code === "network_request_error" || code === "network_response_error") {
    return "检查网络、DNS、防火墙和企业 TLS 检查链；确认后重新运行脚本。";
  }
  if (code === "redirect_limit") {
    return "微软服务重定向次数超限；检查网络代理或中间设备，不要手工改写 URL。";
  }
  if (code === "response_too_large") {
    return "上游响应超过脚本安全限制；保留错误详情并重新查询，勿改用未知镜像。";
  }
  if (code === "storeedge_http_error" || code === "fe3_http_error") {
    return "稍后重试；若持续失败，检查微软服务连通性和请求参数。";
  }
  if (code === "fe3_cookie_error" || code === "fe3_sync_error" || code === "fe3_parse_error") {
    return "检查 FE3 连通性、系统时间和目标市场/通道；不要复用旧的 Cookie 或响应。";
  }
  if (code === "fe3_metadata_incomplete") {
    return "FE3 更新元数据不完整；停止使用该结果，稍后重新查询并保留错误详情。";
  }
  if (code === "fe3_metadata_ambiguous") {
    return "FE3 返回了重复或相互冲突的字段；停止使用该结果，稍后重新查询并保留错误详情。";
  }
  if (code === "invalid_file_metadata") {
    return "FE3 文件元数据不完整或格式无效；停止使用该结果，稍后重新查询。";
  }
  if (code === "fe3_url_error" || code === "url_not_found" || code === "missing_download_url") {
    return "重新查询 FE3 获取新的临时签名 URL；不要缓存或手工拼接下载地址。";
  }
  if (code === "file_not_found" || code === "package_update_missing") {
    return "重新查询 FE3，并确认包身份、UpdateInfo/ID 关联和 Retail 通道未发生变化。";
  }
  if (
    code === "ambiguous_file" ||
    code === "ambiguous_package_update" ||
    code === "ambiguous_extended_update" ||
    code === "ambiguous_download_url" ||
    code === "invalid_update_id" ||
    code === "invalid_revision_number"
  ) {
    return "FE3 返回了无法安全区分的更新信息；停止使用该结果，稍后重新查询并保留错误详情。";
  }
  if (code === "skill_configuration_error") {
    return "检查 Skill 文件是否完整，尤其是 scripts/fetch_links.js 的内置 FE3 配置。";
  }
  if (code === "architecture_failed") {
    return "查看对应架构的错误详情；不要用另一架构或旧 URL 代替失败结果。";
  }
  if (code === "invalid_timeout") return "将 --timeout 设置为 1-300 之间的数字。";
  if (code === "invalid_product_id" || code === "unsupported_product") {
    return "本 Skill 仅支持 ChatGPT Work/Codex 产品 ID 9PLM9XGG6VKS。";
  }
  if (code === "conflicting_tls_mode") {
    return "只保留 --strict-tls 或 --insecure-tls 其中一个选项。";
  }
  if (code === "missing_argument_value" || code === "invalid_argument" || code === "unknown_argument") {
    return "运行 --help 查看参数格式，并检查选项和值是否成对出现。";
  }
  return "根据错误阶段检查参数、网络或微软接口响应。";
}

function printText(result, redactUrl) {
  const product = result.product;
  console.log(
    "产品：" +
      terminalText(product.title, "ChatGPT", 256) +
      "（" +
      terminalText(product.product_id, "未知", 128) +
      "）"
  );
  console.log("发布者：" + terminalText(product.publisher, "未知", 256));
  console.log("PackageFamilyName：" + terminalText(product.package_family_name, "未知", 256));
  console.log(
    "查询范围：" +
      terminalText(result.market, "未知", 32) +
      " / " +
      terminalText(result.locale, "未知", 64) +
      " / " +
      terminalText(result.ring, "未知", 64)
  );
  console.log("StoreEdge 更新时间：" + terminalText(product.last_update_utc, "未知", 128));
  console.log("StoreEdge RevisionId：" + terminalText(product.revision_id, "未知", 256));
  if (Array.isArray(product.metadata_warnings) && product.metadata_warnings.length) {
    console.log("StoreEdge 元数据警告：");
    product.metadata_warnings.forEach((warning) => {
      console.log("- " + terminalText(warning, "未知", 512));
    });
  }
  console.log("检查时间：" + terminalText(result.checked_at_utc, "未知", 128));
  if (result.runtime && typeof result.runtime === "object") {
    console.log(
      "运行环境：" +
        terminalText(result.runtime.environment, "未知", 32) +
        "，Node.js " +
        terminalText(result.runtime.node_version, "未知", 32) +
        "（来源提示：" +
        terminalText(result.runtime.node_source_hint, "未知", 32) +
        "）"
    );
  }
  const tlsModeLabel =
    result.tls_mode === "conflict"
      ? "参数冲突（未执行网络请求）"
      : result.tls_verification_enabled
        ? "已启用"
        : "未启用（兼容模式）";
  console.log("TLS 证书校验：" + tlsModeLabel);
  console.log("来源认证状态：" + (result.tls_verified ? "已验证" : "未验证"));
  if (result.security_warning) {
    console.log("安全警告：" + terminalText(result.security_warning, "未知", 512));
  }
  console.log("结果状态：" + (result.ok ? "全部架构成功" : "存在失败项，退出码为 1"));
  result.artifacts.forEach((artifact, index) => {
    console.log("");
    console.log(
      "[" +
        (index + 1) +
        "] " +
        terminalText(artifact.architecture, "未知", 32) +
        " " +
        terminalText(artifact.version, "未知", 128)
    );
    console.log("文件：" + terminalText(artifact.file_name, "未知", 512));
    console.log("大小：" + artifact.size_bytes + " 字节");
    console.log("修改时间：" + terminalText(artifact.modified_utc, "未知", 128));
    console.log("SHA-1（FE3 Base64）：" + terminalText(artifact.sha1_base64, "未知", 128));
    console.log("SHA-256：" + terminalText(artifact.sha256, "未知", 128));
    console.log("直链：" + terminalText(displayUrl(artifact.url, redactUrl), "未知", 8192));
    console.log("解析地址：" + terminalText(displayUrl(artifact.resolved_url, redactUrl), "未知", 8192));
    console.log("URL 检查时间：" + terminalText(artifact.url_checked_at_utc, "未知", 128));
    console.log("探针尝试次数：" + artifact.probe_attempts);
    console.log("探针 TLS：" + (artifact.tls_verified ? "已验证" : "未验证"));
    console.log("验证范围：" + terminalText(artifact.verification_scope, "未知", 128));
    console.log(
      "完整文件本地哈希：" +
        (artifact.local_hash_verified ? "已验证" : "未计算（SHA-256 来自 FE3 元数据）")
    );
    console.log(
      "CDN 探针：" +
        (artifact.url_verified ? "通过" : "失败") +
        "，方式=" +
        artifact.probe_method +
        "，HTTP " +
        artifact.http_status
    );
  });
  if (result.errors && result.errors.length) {
    console.log("");
    console.log("部分架构或步骤失败：");
    result.errors.forEach((error, index) => {
      console.log(
        "[错误 " +
          (index + 1) +
          "] " +
          terminalText(error.error_code, "discovery_error", 64) +
          (error.architecture ? "（" + terminalText(error.architecture, "未知", 32) + "）" : "")
      );
      console.log("原因：" + terminalText(error.message, "未知", 1024));
      if (Number.isSafeInteger(error.http_status) && error.http_status > 0) {
        console.log("HTTP：" + error.http_status);
      }
      if (Number.isSafeInteger(error.attempts) && error.attempts > 0) {
        console.log("尝试次数：" + error.attempts);
      }
      if (Number.isSafeInteger(error.retry_after_ms) && error.retry_after_ms > 0) {
        console.log("建议等待：" + error.retry_after_ms + " 毫秒");
      }
      console.log("建议：" + terminalText(error.next_action, "请根据错误信息排查。", 1024));
    });
  }
  console.log("");
  console.log("提示：本 Skill 只发现并校验官方临时直链，不下载完整文件、不安装应用、不获取许可证。");
  console.log("微软 CDN 直链带时效签名，请尽快下载；失效后重新运行本脚本。");
}

function displayUrl(value, redact) {
  const text = String(value || "");
  if (!redact || !text) return text;
  try {
    const parsed = new URL(text);
    parsed.search = parsed.search ? "?redacted" : "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return "<redacted>";
  }
}

function redactReportUrls(report) {
  if (!report || typeof report !== "object") return report;
  const copy = JSON.parse(JSON.stringify(report));
  copy.redact_url = true;
  if (Array.isArray(copy.artifacts)) {
    copy.artifacts.forEach((artifact) => {
      artifact.url = displayUrl(artifact.url, true);
      artifact.resolved_url = displayUrl(artifact.resolved_url, true);
      artifact.source_url = displayUrl(artifact.source_url, true);
    });
  }
  return copy;
}

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(message);
}

function expectSelfTestError(operation, code, messagePart) {
  let caught = null;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assertSelfTest(caught, "应当失败：" + code);
  if (code === "discovery_error") {
    assertSelfTest(
      !caught.code || caught.code === "discovery_error",
      "错误码不匹配：期望通用错误，实际 " + (caught.code || "无")
    );
  } else {
    assertSelfTest(
      caught.code === code,
      "错误码不匹配：期望 " + code + "，实际 " + (caught.code || "无")
    );
  }
  if (messagePart) {
    assertSelfTest(
      String(caught.message || "").includes(messagePart),
      "错误消息缺少：" + messagePart
    );
  }
  return caught;
}

function runSelfTests() {
  const tests = [];
  const add = (name, operation) => tests.push({ name, operation });
  add("参数缺少值（末尾）", () => {
    expectSelfTestError(() => parseArgs(["--arch"]), "missing_argument_value", "缺少参数值");
  });
  add("参数缺少值（下一个选项）", () => {
    expectSelfTestError(
      () => parseArgs(["--arch", "--json"]),
      "missing_argument_value",
      "缺少参数值"
    );
  });
  add("等号参数缺少值", () => {
    expectSelfTestError(() => parseArgs(["--timeout="]), "missing_argument_value", "缺少参数值");
  });
  add("负数 timeout 作为值进行范围校验", () => {
    expectSelfTestError(() => parseArgs(["--timeout", "-1"]), "invalid_timeout", "至少为 1");
  });
  add("TLS 参数冲突显式标记", () => {
    const error = expectSelfTestError(
      () => parseArgs(["--strict-tls", "--insecure-tls", "--json"]),
      "conflicting_tls_mode",
      "不能同时使用"
    );
    assertSelfTest(error.tls_mode === "conflict", "TLS 冲突错误缺少 tls_mode=conflict");
    const status = tlsStatusForArgs({ tlsMode: "conflict", insecureTls: false });
    assertSelfTest(status.tls_mode === "conflict", "TLS 状态模式错误");
    assertSelfTest(status.tls_verification_enabled === false, "TLS 冲突不应显示为已启用");
    assertSelfTest(status.security_warning.includes("未执行网络请求"), "TLS 冲突缺少网络请求警告");
  });
  add("严格 TLS 下参数错误仍保留状态", () => {
    const initial = initialCliState(["--strict-tls", "--arch"]);
    assertSelfTest(initial.tlsMode === "strict", "严格 TLS 预扫描状态错误");
    expectSelfTestError(() => parseArgs(["--strict-tls", "--arch"]), "missing_argument_value");
    const status = tlsFieldsForResult(initial, false);
    assertSelfTest(status.tls_mode === "strict", "参数错误不应回退到兼容 TLS");
    assertSelfTest(status.tls_verification_enabled === true, "严格 TLS 参数错误状态不一致");
    assertSelfTest(status.tls_verified === false, "参数错误不应声称来源已验证");
  });
  add("严格 TLS 状态", () => {
    const status = tlsFieldsForResult({ tlsMode: "strict", insecureTls: false }, true);
    assertSelfTest(status.tls_mode === "strict", "严格 TLS 模式错误");
    assertSelfTest(status.tls_verification_enabled === true, "严格 TLS 未标记为启用");
    assertSelfTest(status.tls_verified === true, "严格 TLS 成功结果未标记为已验证");
    assertSelfTest(status.security_warning === "", "严格 TLS 不应带兼容模式警告");
  });
  add("兼容 TLS 状态", () => {
    const status = tlsFieldsForResult({ tlsMode: "insecure", insecureTls: true }, true);
    assertSelfTest(status.tls_mode === "insecure", "兼容 TLS 模式错误");
    assertSelfTest(status.tls_verification_enabled === false, "兼容模式不应显示已启用 TLS 校验");
    assertSelfTest(status.tls_verified === false, "兼容模式不应标记来源已验证");
    assertSelfTest(Boolean(status.security_warning), "兼容模式缺少安全警告");
  });
  add("Windows 文件名规则", () => {
    validateWindowsFilename("OpenAI.Codex_x64.Msix", "测试");
    expectSelfTestError(() => validateWindowsFilename("CON.txt", "测试"), "discovery_error");
    expectSelfTestError(() => validateWindowsFilename("name. ", "测试"), "discovery_error");
    expectSelfTestError(() => validateWindowsFilename("bad/name", "测试"), "discovery_error");
  });
  add("Content-Disposition 引号与逗号", () => {
    const names = headerFilenameCandidates({
      "content-disposition": 'attachment; filename="OpenAI.Codex, x64.Msix"',
    });
    assertSelfTest(names.length === 1 && names[0] === "OpenAI.Codex, x64.Msix", "带逗号文件名解析错误");
    const encoded = headerFilenameCandidates({
      "content-disposition": "attachment; filename*=UTF-8''OpenAI.Codex_x64.Msix",
    });
    assertSelfTest(encoded[0] === "OpenAI.Codex_x64.Msix", "filename* 解析错误");
  });
  add("Content-Disposition 重复冲突", () => {
    expectSelfTestError(
      () => validateProbeResponse(
        {
          statusCode: 200,
          headers: {
            "content-length": "10",
            "content-disposition": [
              'attachment; filename="one.Msix"',
              'attachment; filename="two.Msix"',
            ],
          },
        },
        "HEAD",
        10,
        ["one.Msix", "two.Msix"]
      ),
      "discovery_error",
      "相互冲突"
    );
  });
  add("HEAD 大小校验", () => {
    const checked = validateProbeResponse(
      { statusCode: 200, headers: { "content-length": "10" } },
      "HEAD",
      10,
      ["file.Msix"]
    );
    assertSelfTest(checked.content_length === 10, "HEAD 大小解析错误");
    expectSelfTestError(
      () => validateProbeResponse(
        { statusCode: 200, headers: { "content-length": "9" } },
        "HEAD",
        10,
        ["file.Msix"]
      ),
      "discovery_error",
      "大小不匹配"
    );
  });
  add("Range 206 校验", () => {
    const checked = validateProbeResponse(
      {
        statusCode: 206,
        headers: { "content-length": "1", "content-range": "bytes 0-0/10" },
        body: Buffer.from([0]),
      },
      "GET-range",
      10,
      ["file.Msix"]
    );
    assertSelfTest(checked.total_length === 10, "Range 总大小解析错误");
    expectSelfTestError(
      () => validateProbeResponse(
        {
          statusCode: 206,
          headers: { "content-length": "1", "content-range": "bytes 1-1/10" },
          body: Buffer.from([0]),
        },
        "GET-range",
        10,
        ["file.Msix"]
      ),
      "discovery_error",
      "Content-Range 不匹配"
    );
  });
  add("URL 主机边界", () => {
    expectSelfTestError(
      () => ensureAllowedHost("https://dl.delivery.mp.microsoft.com/file", []),
      "skill_configuration_error",
      "白名单"
    );
    expectSelfTestError(
      () => ensureAllowedHost("http://dl.delivery.mp.microsoft.com/file", ["dl.delivery.mp.microsoft.com"]),
      "discovery_error",
      "HTTPS"
    );
    expectSelfTestError(
      () => ensureAllowedHost("https://evil.example/file", ["dl.delivery.mp.microsoft.com"]),
      "discovery_error",
      "未授权主机"
    );
    expectSelfTestError(
      () => ensureAllowedHost("https://user:pass@dl.delivery.mp.microsoft.com/file", ["dl.delivery.mp.microsoft.com"]),
      "discovery_error",
      "凭据"
    );
  });
  add("Retry-After 解析与上限", () => {
    assertSelfTest(retryAfterMs({ "retry-after": "2" }) === 2000, "Retry-After 秒数解析错误");
    assertSelfTest(retryAfterMs({ "retry-after": "999" }) === MAX_RETRY_AFTER_MS, "Retry-After 上限错误");
    assertSelfTest(retryAfterMs({ "retry-after": ["无效", "1"] }) === 1000, "重复 Retry-After 未跳过无效值");
  });
  add("摘要格式与版本比较", () => {
    const digest = Buffer.alloc(32, 0).toString("base64");
    assertSelfTest(isCanonicalBase64(digest), "规范 Base64 判断错误");
    assertSelfTest(compareVersions("26.10.0.0", "26.9.99.0") > 0, "版本比较错误");
    expectSelfTestError(() => decodeBase64Digest("not-a-digest", 32, "SHA-256"), "discovery_error", "SHA-256");
  });
  add("FE3 重复字段拒绝", () => {
    const payload = Buffer.from(
      "<Envelope><UpdateInfo><ID>1</ID><ID>2</ID><Xml>&lt;UpdateIdentity UpdateID=\"00000000-0000-0000-0000-000000000000\" RevisionNumber=\"1\" /&gt;</Xml></UpdateInfo></Envelope>",
      "utf8"
    );
    expectSelfTestError(
      () => parseSyncUpdates(payload, EXPECTED_PACKAGE_FAMILY_NAME),
      "fe3_metadata_incomplete",
      "缺失或重复"
    );
  });
  add("时间戳必须带时区", () => {
    assertSelfTest(isValidTimestamp("2026-09-05T22:51:59.3418258Z"), "带 Z 的时间戳应有效");
    assertSelfTest(isValidTimestamp("2026-09-05T22:51:59+08:00"), "带偏移的时间戳应有效");
    assertSelfTest(isValidTimestamp("2026-09-05T22:51:59+23:59"), "合法的最大时区偏移应有效");
    assertSelfTest(!isValidTimestamp("2026-09-05T22:51:59"), "缺少时区的时间戳不应接受");
    assertSelfTest(!isValidTimestamp("2026-09-05 22:51:59Z"), "非 ISO 时间戳不应接受");
    assertSelfTest(!isValidTimestamp("2026-02-30T00:00:00Z"), "不存在的日期不应接受");
    assertSelfTest(!isValidTimestamp("2026-01-01T24:00:00Z"), "超出范围的小时不应接受");
    assertSelfTest(!isValidTimestamp("2026-01-01T00:00:00+24:00"), "超出范围的时区不应接受");
  });
  add("运行环境诊断不泄露路径", () => {
    const runtime = runtimeEnvironment();
    assertSelfTest(["darwin", "linux", "win32"].includes(runtime.platform) || runtime.platform === "unknown", "运行平台字段无效");
    assertSelfTest(typeof runtime.environment === "string" && runtime.environment.length > 0, "运行环境字段缺失");
    assertSelfTest(typeof runtime.node_version === "string" && runtime.node_version.length > 0, "Node.js 版本字段缺失");
    assertSelfTest(typeof runtime.node_source_hint === "string" && runtime.node_source_hint.length > 0, "Node.js 来源提示缺失");
    assertSelfTest(!Object.prototype.hasOwnProperty.call(runtime, "node_path"), "运行环境不应输出 Node.js 路径");
  });
  add("常见平台和 Node 来源识别", () => {
    const cases = [
      {
        options: {
          platform: "linux",
          architecture: "x64",
          nodeVersion: "20.11.1",
          execPath: "/home/user/.nvm/versions/node/v20.11.1/bin/node",
          environment: { WSL_DISTRO_NAME: "Ubuntu" },
        },
        expectedEnvironment: "wsl",
        expectedSource: "nvm",
      },
      {
        options: {
          platform: "win32",
          architecture: "x64",
          nodeVersion: "22.1.0",
          execPath: "C:/Users/user/AppData/Local/Volta/tools/image/node/22.1.0/node.exe",
          environment: {},
        },
        expectedEnvironment: "windows",
        expectedSource: "volta",
      },
      {
        options: {
          platform: "linux",
          architecture: "arm64",
          nodeVersion: "18.20.4",
          execPath: "/usr/bin/node",
          environment: { NVM_DIR: "/home/user/.nvm" },
        },
        expectedEnvironment: "linux",
        expectedSource: "system",
      },
      {
        options: {
          platform: "darwin",
          architecture: "arm64",
          nodeVersion: "24.19.0",
          execPath: "/opt/homebrew/bin/node",
          environment: { NVM_DIR: "/Users/user/.nvm" },
        },
        expectedEnvironment: "macos",
        expectedSource: "system",
      },
      {
        options: {
          platform: "linux",
          architecture: "x64",
          nodeVersion: "22.14.0",
          execPath: "/home/user/.local/share/mise/installs/node/22.14.0/bin/node",
          environment: {},
        },
        expectedEnvironment: "linux",
        expectedSource: "mise",
      },
      {
        options: {
          platform: "darwin",
          architecture: "arm64",
          nodeVersion: "20.18.0",
          execPath: "/Users/user/.nodenv/versions/20.18.0/bin/node",
          environment: {},
        },
        expectedEnvironment: "macos",
        expectedSource: "nodenv",
      },
      {
        options: {
          platform: "darwin",
          architecture: "x64",
          nodeVersion: "20.18.2",
          execPath: "/usr/local/n/versions/node/20.18.2/bin/node",
          environment: {},
        },
        expectedEnvironment: "macos",
        expectedSource: "n",
      },
    ];
    for (const item of cases) {
      const runtime = detectRuntimeEnvironment(item.options);
      assertSelfTest(runtime.environment === item.expectedEnvironment, "平台识别错误");
      assertSelfTest(runtime.node_source_hint === item.expectedSource, "Node.js 来源识别错误");
      assertSelfTest(runtime.host_architecture === item.options.architecture, "主机架构识别错误");
    }
  });
  add("版本管理器来源覆盖", () => {
    const cases = [
      { environment: { NVM_HOME: "C:/nvm" }, execPath: "C:/nvm/v20/node.exe", expected: "nvm-windows" },
      { environment: { VOLTA_HOME: "C:/volta" }, execPath: "C:/volta/tools/image/node/22.0.0/node.exe", expected: "volta" },
      { environment: { ASDF_DIR: "/opt/asdf" }, execPath: "/opt/asdf/shims/node", expected: "asdf" },
      { environment: { FNM_DIR: "/home/user/.fnm" }, execPath: "/home/user/.fnm/node-versions/v20/bin/node", expected: "fnm" },
      { environment: { NVS_HOME: "/home/user/.nvs" }, execPath: "/home/user/.nvs/node/20/bin/node", expected: "nvs" },
      { environment: {}, execPath: "/home/user/.local/share/fnm/node-versions/v20/bin/node", expected: "fnm" },
      { environment: {}, execPath: "/opt/homebrew/opt/node@22/bin/node", expected: "system" },
    ];
    for (const item of cases) {
      const runtime = detectRuntimeEnvironment({
        platform: item.expected === "nvm-windows" || item.expected === "volta" ? "win32" : "linux",
        architecture: "x64",
        nodeVersion: "20.0.0",
        execPath: item.execPath,
        environment: item.environment,
      });
      assertSelfTest(runtime.node_source_hint === item.expected, "版本管理器来源覆盖识别错误");
    }
  });
  add("WSL 内核标记回退", () => {
    const wsl = detectRuntimeEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.0.0",
      execPath: "/usr/bin/node",
      environment: {},
      kernelRelease: "5.15.167.4-microsoft-standard-WSL2",
    });
    assertSelfTest(wsl.environment === "wsl", "缺少 WSL 环境变量时未识别内核标记");
    const linux = detectRuntimeEnvironment({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "24.0.0",
      execPath: "/usr/bin/node",
      environment: {},
      kernelRelease: "6.8.0-31-generic",
    });
    assertSelfTest(linux.environment === "linux", "普通 Linux 内核被误识别为 WSL");
  });
  const failures = [];
  for (const test of tests) {
    try {
      test.operation();
    } catch (error) {
      failures.push({ name: test.name, message: sanitizeMessage(error && error.message) });
    }
  }
  return {
    ok: failures.length === 0,
    test_count: tests.length,
    passed: tests.length - failures.length,
    failed: failures.length,
    failures,
    network_accessed: false,
    disk_accessed: false,
  };
}

async function main() {
  const cliArgs = process.argv.slice(2);
  let args = initialCliState(cliArgs);
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return 0;
    }
    ensureSupportedNodeVersion();
    if (args.selfTest) {
      const report = runSelfTests();
      report.runtime = runtimeEnvironment();
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(
          "离线自测：" +
            (report.ok ? "通过" : "失败") +
            "（" + report.passed + "/" + report.test_count + "）"
        );
        if (report.runtime && typeof report.runtime === "object") {
          console.log(
            "运行环境：" +
              terminalText(report.runtime.environment, "未知", 32) +
              "，Node.js " +
              terminalText(report.runtime.node_version, "未知", 32) +
              "（来源提示：" +
              terminalText(report.runtime.node_source_hint, "未知", 32) +
              "）"
          );
        }
        report.failures.forEach((failure) => console.log("- " + failure.name + "：" + failure.message));
      }
      return report.ok ? 0 : 1;
    }
    const result = attachRuntimeEnvironment(await run(args));
    if (args.json) console.log(JSON.stringify(args.redactUrl ? redactReportUrls(result) : result, null, 2));
    else printText(result, args.redactUrl);
    return result.ok ? 0 : 1;
  } catch (error) {
    const details = errorObject(error);
    if (args && args.json) {
      const tls = tlsFieldsForResult(args, false);
      const failure = Object.assign(
        {
          ok: false,
          error: details.message,
          next_action: nextActionForError(error),
          ...tls,
        },
        details
      );
      failure.runtime = runtimeEnvironment();
      console.log(
        JSON.stringify(failure, null, 2)
      );
    } else {
      console.error("获取失败 [" + details.error_code + "]：" + details.message);
      const runtime = runtimeEnvironment();
      console.error(
        "运行环境：" +
          runtime.environment +
          "，Node.js " +
          runtime.node_version +
          "（来源提示：" +
          runtime.node_source_hint +
          "）"
      );
      console.error("建议：" + nextActionForError(error));
    }
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
