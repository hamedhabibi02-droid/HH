import { Readable as StreamReadable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";

// تنظیمات اولیه API
export const config = {
  api: { bodyParser: false }, // غیرفعال کردن body parser
  supportsResponseStreaming: true, // فعال بودن استریم
  maxDuration: 60, // حداکثر زمان اجرا
};

// گرفتن دامنه مقصد و حذف اسلش انتهایی
const BASE_TARGET_URL = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

// لیست هدرهایی که باید حذف شوند
const BLOCKED_HEADER_SET = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// هندلر اصلی درخواست
export default async function requestHandler(incomingReq, outgoingRes) {
  
  // بررسی تنظیم بودن دامنه
  if (!BASE_TARGET_URL) {
    outgoingRes.statusCode = 500;
    return outgoingRes.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    // ساخت URL مقصد
    const fullTargetUrl = BASE_TARGET_URL + incomingReq.url;

    // آبجکت هدر جدید
    const forwardHeaders = {};

    // آی‌پی کلاینت
    let detectedClientIp = null;

    // پردازش هدرهای ورودی
    for (const headerKey of Object.keys(incomingReq.headers)) {
      const lowerKey = headerKey.toLowerCase();
      const headerValue = incomingReq.headers[headerKey];

      // حذف هدرهای بلاک شده
      if (BLOCKED_HEADER_SET.has(lowerKey)) continue;

      // حذف هدرهای ورسل
      if (lowerKey.startsWith("x-vercel-")) continue;

      // مدیریت آی‌پی واقعی
      if (lowerKey === "x-real-ip") {
        detectedClientIp = headerValue;
        continue;
      }

      // مدیریت x-forwarded-for
      if (lowerKey === "x-forwarded-for") {
        if (!detectedClientIp) detectedClientIp = headerValue;
        continue;
      }

      // ست کردن هدر
      forwardHeaders[lowerKey] = Array.isArray(headerValue)
        ? headerValue.join(", ")
        : headerValue;
    }

    // اضافه کردن آی‌پی نهایی
    if (detectedClientIp) {
      forwardHeaders["x-forwarded-for"] = detectedClientIp;
    }

    // متد درخواست
    const requestMethod = incomingReq.method;

    // بررسی داشتن بادی
    const shouldHaveBody = requestMethod !== "GET" && requestMethod !== "HEAD";

    // تنظیمات fetch
    const fetchConfig = {
      method: requestMethod,
      headers: forwardHeaders,
      redirect: "manual",
    };

    // اگر بادی وجود دارد
    if (shouldHaveBody) {
      fetchConfig.body = StreamReadable.toWeb(incomingReq);
      fetchConfig.duplex = "half"; // لازم برای Node fetch
    }

    // ارسال درخواست به سرور مقصد
    const upstreamResponse = await fetch(fullTargetUrl, fetchConfig);

    // تنظیم status
    outgoingRes.statusCode = upstreamResponse.status;

    // انتقال هدرها
    for (const [respKey, respValue] of upstreamResponse.headers) {
      if (respKey.toLowerCase() === "transfer-encoding") continue;

      try {
        outgoingRes.setHeader(respKey, respValue);
      } catch {
        // در صورت خطا، نادیده بگیر
      }
    }

    // استریم پاسخ
    if (upstreamResponse.body) {
      await streamPipeline(
        StreamReadable.fromWeb(upstreamResponse.body),
        outgoingRes
      );
    } else {
      // اگر بادی ندارد
      outgoingRes.end();
    }

  } catch (errorCaught) {
    // لاگ خطا
    console.error("relay error:", errorCaught);

    // اگر هنوز هدر ارسال نشده
    if (!outgoingRes.headersSent) {
      outgoingRes.statusCode = 502;
      outgoingRes.end("Bad Gateway: Tunnel Failed");
    }
  }
}
