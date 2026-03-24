const express = require("express");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const Visitor = require("./visitorModel");
const VipPass = require("./vipPassModel");

const router = express.Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const DEPARTMENT_OPTIONS = [
  "IT",
  "HR",
  "Quality",
  "R&D",
  "Sales and Marketing",
  "Production/Manufacturing",
];

const VISITOR_TYPE_OPTIONS = ["Customer", "Vendor", "Visitor", "Maintenance"];

const RICO_UNITS = [
  "Bawal",
  "Pathredi",
  "Dharuhera",
  "Chennai",
  "Hosur",
  "Gurugram",
  "Haridwar",
];

const ALLOWED_ANALYTIC_RANGES = new Set([7, 14, 30, 180, 365]);
const VIP_DEFAULT_DEPARTMENT = "IT";
const VIP_DEFAULT_UNIT = "Gurugram";
const DEFAULT_APPROVAL_EMAIL = "paul.r212003@gmail.com";
const ANALYTICS_UTC_OFFSET_MINUTES = Number.parseInt(
  String(process.env.ANALYTICS_UTC_OFFSET_MINUTES || "330"),
  10
);
const ANALYTICS_OFFSET_MS = (Number.isFinite(ANALYTICS_UTC_OFFSET_MINUTES) ? ANALYTICS_UTC_OFFSET_MINUTES : 330) * 60 * 1000;

const normalizePhone = (phone = "") => String(phone).replace(/\D/g, "");
const normalizeName = (name = "") => String(name).trim().replace(/\s+/g, " ");
let approvalTransporter = null;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDateStamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function localDateKey(dateValue) {
  const date = new Date(dateValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function humanDayLabel(dateValue) {
  return new Date(dateValue).toLocaleDateString([], {
    day: "2-digit",
    month: "short",
  });
}

function hourLabel(hour) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(hour12).padStart(2, "0")}:00 ${suffix}`;
}

function toAnalyticsLocalDate(dateValue) {
  return new Date(new Date(dateValue).getTime() + ANALYTICS_OFFSET_MS);
}

function fromAnalyticsLocalDate(dateValue) {
  return new Date(new Date(dateValue).getTime() - ANALYTICS_OFFSET_MS);
}

function analyticsLocalDateKey(dateValue) {
  const date = toAnalyticsLocalDate(dateValue);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function analyticsHumanDayLabel(dateValue) {
  return toAnalyticsLocalDate(dateValue).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function analyticsHourOfArrival(dateValue) {
  return toAnalyticsLocalDate(dateValue).getUTCHours();
}

function analyticsRangeWindow(rangeDays) {
  const analyticsNow = toAnalyticsLocalDate(new Date());
  const endLocal = new Date(
    Date.UTC(
      analyticsNow.getUTCFullYear(),
      analyticsNow.getUTCMonth(),
      analyticsNow.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
  const startLocal = new Date(endLocal);
  startLocal.setUTCDate(startLocal.getUTCDate() - (rangeDays - 1));
  startLocal.setUTCHours(0, 0, 0, 0);

  return {
    start: fromAnalyticsLocalDate(startLocal),
    end: fromAnalyticsLocalDate(endLocal),
  };
}

function normalizeCompanyType(value) {
  const clean = String(value || "").trim();
  if (/^rico$/i.test(clean)) return "RICO";
  if (/^other$/i.test(clean)) return "Other";
  return clean;
}

function normalizeRicoUnit(value) {
  const clean = String(value || "").trim();
  const matched = RICO_UNITS.find((unit) => unit.toLowerCase() === clean.toLowerCase());
  return matched || "";
}

function normalizeDepartment(value) {
  const clean = String(value || "").trim();
  const matched = DEPARTMENT_OPTIONS.find((item) => item.toLowerCase() === clean.toLowerCase());
  return matched || "";
}

function normalizeVisitorType(value) {
  const clean = String(value || "").trim();
  const matched = VISITOR_TYPE_OPTIONS.find((item) => item.toLowerCase() === clean.toLowerCase());
  return matched || "Visitor";
}

function parseCarriesLaptop(value) {
  if (typeof value === "boolean") return value;

  const normalized = String(value || "").trim().toLowerCase();
  if (["yes", "true", "1"].includes(normalized)) return true;
  if (["no", "false", "0"].includes(normalized)) return false;
  return null;
}

function getAdminPassword(req) {
  return String(req.body?.adminPassword || req.headers["x-admin-password"] || req.query?.adminPassword || "").trim();
}

function buildPassQrPayload(passId, phone = "") {
  return `RICO-PASS|${String(passId || "").trim().toUpperCase()}|${normalizePhone(phone)}`;
}

async function createQrDataUrl(payload) {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 260,
  });
}

function createHttpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function getApprovalRecipient() {
  return String(process.env.APPROVAL_EMAIL_TO || DEFAULT_APPROVAL_EMAIL).trim();
}

function isApprovalEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && getApprovalRecipient());
}

function getApprovalTransporter() {
  if (!isApprovalEmailConfigured()) return null;

  if (!approvalTransporter) {
    const secureSetting = String(process.env.SMTP_SECURE || "true").trim().toLowerCase();
    const secure = !["false", "0", "no"].includes(secureSetting);
    const port = Number.parseInt(String(process.env.SMTP_PORT || (secure ? "465" : "587")), 10);

    approvalTransporter = nodemailer.createTransport({
      host: String(process.env.SMTP_HOST || "").trim(),
      port: Number.isFinite(port) ? port : secure ? 465 : 587,
      secure,
      auth: {
        user: String(process.env.SMTP_USER || "").trim(),
        pass: String(process.env.SMTP_PASS || "").trim(),
      },
    });
  }

  return approvalTransporter;
}

function getBaseUrl(req) {
  const configured = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();

  if (!forwardedHost) return "";
  return `${forwardedProto || (req.secure ? "https" : "http")}://${forwardedHost}`;
}

function approvalBadgeColor(decision = "pending") {
  if (decision === "approved") return "#2fd0a6";
  if (decision === "denied") return "#ff6b7a";
  return "#ffd166";
}

function renderApprovalDecisionPage({ title, message, visitor, decision = "pending" }) {
  const color = approvalBadgeColor(decision);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #071321;
        color: #f5fbff;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 20px;
      }
      .card {
        width: min(560px, 100%);
        background: rgba(9, 25, 42, 0.96);
        border: 1px solid rgba(127, 212, 255, 0.2);
        border-radius: 18px;
        padding: 28px;
        box-shadow: 0 20px 44px rgba(0, 0, 0, 0.35);
      }
      .badge {
        display: inline-block;
        margin-bottom: 16px;
        padding: 8px 12px;
        border-radius: 999px;
        background: ${color};
        color: #081018;
        font-weight: 700;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.6rem;
      }
      p {
        color: #c8dced;
        line-height: 1.6;
      }
      ul {
        margin: 20px 0 0;
        padding: 0;
        list-style: none;
      }
      li {
        padding: 10px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      strong {
        color: #ffffff;
      }
    </style>
  </head>
  <body>
    <article class="card">
      <span class="badge">${decision.toUpperCase()}</span>
      <h1>${title}</h1>
      <p>${message}</p>
      <ul>
        <li><strong>Pass ID:</strong> ${visitor?.passId || "-"}</li>
        <li><strong>Visitor:</strong> ${visitor?.name || "-"}</li>
        <li><strong>Phone:</strong> ${visitor?.phone || "-"}</li>
        <li><strong>Purpose:</strong> ${visitor?.visitType || "-"}</li>
        <li><strong>Person To Meet:</strong> ${visitor?.personToMeet || "-"}</li>
      </ul>
    </article>
  </body>
</html>`;
}

function buildApprovalEmailHtml({ visitor, allowUrl, denyUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f8fc;font-family:Arial,sans-serif;color:#102235;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:640px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dbe7f1;">
            <tr>
              <td style="padding:24px 28px;background:#08192d;color:#ffffff;">
                <p style="margin:0 0 8px;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#84d3ff;">RICO Visitor Approval</p>
                <h1 style="margin:0;font-size:24px;">Approval Required For Visitor Entry</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin-top:0;">A new visitor approval request has been submitted. Review the details below and click the action button.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:collapse;">
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Pass ID</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.passId}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Name</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.name}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Phone</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.phone}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Visitor Type</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.visitorType || "-"}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Company</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.company || "-"}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Purpose</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.visitType || "-"}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Person To Meet</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.personToMeet || "-"}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #e8eef5;"><strong>Department</strong></td><td style="padding:10px 0;border-bottom:1px solid #e8eef5;">${visitor.department || "-"}</td></tr>
                  <tr><td style="padding:10px 0;"><strong>Requested At</strong></td><td style="padding:10px 0;">${new Date(visitor.approvalRequestedAt || visitor.createdAt || new Date()).toLocaleString("en-IN")}</td></tr>
                </table>
                <div style="margin-top:26px;">
                  <a href="${allowUrl}" style="display:inline-block;padding:13px 22px;border-radius:999px;background:#18c98a;color:#081018;text-decoration:none;font-weight:700;margin-right:12px;">Allow</a>
                  <a href="${denyUrl}" style="display:inline-block;padding:13px 22px;border-radius:999px;background:#ff6b7a;color:#ffffff;text-decoration:none;font-weight:700;">Deny</a>
                </div>
                <p style="margin:22px 0 0;color:#5a7085;font-size:13px;">If the buttons do not work, open these links manually:</p>
                <p style="margin:8px 0 0;font-size:12px;word-break:break-all;color:#5a7085;">Allow: ${allowUrl}</p>
                <p style="margin:6px 0 0;font-size:12px;word-break:break-all;color:#5a7085;">Deny: ${denyUrl}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildApprovalEmailText({ visitor, allowUrl, denyUrl }) {
  return [
    "RICO Visitor Approval Request",
    `Pass ID: ${visitor.passId}`,
    `Name: ${visitor.name}`,
    `Phone: ${visitor.phone}`,
    `Visitor Type: ${visitor.visitorType || "-"}`,
    `Company: ${visitor.company || "-"}`,
    `Purpose: ${visitor.visitType || "-"}`,
    `Person To Meet: ${visitor.personToMeet || "-"}`,
    `Department: ${visitor.department || "-"}`,
    "",
    `Allow: ${allowUrl}`,
    `Deny: ${denyUrl}`,
  ].join("\n");
}

function buildVisitorPayload(rawBody = {}) {
  const {
    name,
    phone,
    visitorType,
    companyType,
    company,
    companyName,
    otherCompanyName,
    ricoUnit,
    visitType,
    personToMeet,
    department,
    idProofType,
    idProofNumber,
    carriesLaptop,
    laptopSerialNumber,
    remarks,
  } = rawBody || {};

  const normalizedCompanyTypeRaw = normalizeCompanyType(companyType);
  const normalizedCompanyType = ["RICO", "Other"].includes(normalizedCompanyTypeRaw) ? normalizedCompanyTypeRaw : "";
  const normalizedOtherCompany = String(
    otherCompanyName || companyName || (normalizedCompanyType !== "RICO" ? company : "") || ""
  ).trim();
  const normalizedCarriesLaptop = parseCarriesLaptop(carriesLaptop);
  const hasLaptop = normalizedCarriesLaptop === null ? false : normalizedCarriesLaptop;
  const normalizedDepartment = normalizeDepartment(department);

  const payload = {
    name: normalizeName(name),
    phone: normalizePhone(phone),
    visitorType: normalizeVisitorType(visitorType),
    companyType: normalizedCompanyType,
    company: normalizedCompanyType === "RICO" ? "RICO" : normalizedOtherCompany,
    ricoUnit: normalizeRicoUnit(ricoUnit),
    visitType: String(visitType || "").trim(),
    personToMeet: String(personToMeet || "").trim(),
    department: normalizedDepartment,
    idProofType: String(idProofType || "").trim(),
    idProofNumber: String(idProofNumber || "").trim(),
    carriesLaptop: hasLaptop,
    laptopSerialNumber: String(laptopSerialNumber || "").trim(),
    remarks: String(remarks || "").trim(),
    isVip: false,
    vipAccessId: "",
  };

  const requiredFields = ["name", "phone", "personToMeet", "visitType"];
  const missing = requiredFields.filter((field) => !payload[field]);
  if (missing.length) {
    throw createHttpError(400, `Missing required fields: ${missing.join(", ")}`);
  }

  if (payload.companyType === "RICO" && payload.ricoUnit && !RICO_UNITS.includes(payload.ricoUnit)) {
    throw createHttpError(400, "Select a valid RICO unit.");
  }

  if (payload.companyType !== "RICO") {
    payload.ricoUnit = "";
  }

  if (payload.department && !DEPARTMENT_OPTIONS.includes(payload.department)) {
    throw createHttpError(400, "Select a valid department.");
  }

  if (!payload.carriesLaptop) {
    payload.laptopSerialNumber = "";
  }

  return payload;
}

async function ensureNewPassAllowed(payload) {
  const exactNameFilter = {
    name: { $regex: `^${escapeRegex(payload.name)}$`, $options: "i" },
  };

  const exactNamePhoneMatch = await Visitor.findOne({
    ...exactNameFilter,
    phone: payload.phone,
  }).sort({ createdAt: -1 });

  if (exactNamePhoneMatch) {
    throw createHttpError(409, "Same name and phone already exists. Kindly renew pass for this individual.", {
      code: "RENEW_REQUIRED",
      visitor: exactNamePhoneMatch,
    });
  }
}

function parseDateStart(dateText) {
  const value = String(dateText || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseDateEnd(dateText) {
  const value = String(dateText || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

async function generateVisitorPassId(prefix = "PASS") {
  const dateStamp = formatDateStamp(new Date());
  const keyPrefix = `${prefix}-${dateStamp}-`;
  let sequence = (await Visitor.countDocuments({ passId: new RegExp(`^${keyPrefix}`) })) + 1;

  while (true) {
    const passId = `${keyPrefix}${String(sequence).padStart(4, "0")}`;
    const exists = await Visitor.exists({ passId });
    if (!exists) return passId;
    sequence += 1;
  }
}

async function generateVipAccessId() {
  const dateStamp = formatDateStamp(new Date());
  const keyPrefix = `VIPKEY-${dateStamp}-`;
  let sequence = (await VipPass.countDocuments({ vipAccessId: new RegExp(`^${keyPrefix}`) })) + 1;

  while (true) {
    const vipAccessId = `${keyPrefix}${String(sequence).padStart(4, "0")}`;
    const exists = await VipPass.exists({ vipAccessId });
    if (!exists) return vipAccessId;
    sequence += 1;
  }
}

async function generateVipPhone() {
  for (let i = 0; i < 30; i += 1) {
    const phone = `9${String(Math.floor(100000000 + Math.random() * 900000000))}`;
    const exists = await Visitor.exists({ phone });
    if (!exists) return phone;
  }
  return `9${Date.now().toString().slice(-9)}`;
}

async function buildNameSuggestions(query, limit = 10) {
  const cleanQuery = normalizeName(query);
  if (!cleanQuery) return [];

  const matches = await Visitor.find({
    name: { $regex: `^${escapeRegex(cleanQuery)}`, $options: "i" },
  })
    .sort({ createdAt: -1 })
    .select("name -_id")
    .lean();

  const unique = [];
  const seen = new Set();
  for (const entry of matches) {
    const name = normalizeName(entry?.name || "");
    if (!name) continue;
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    unique.push(name);
    if (unique.length >= limit) break;
  }
  return unique;
}

router.get("/nameSuggestions", async (req, res) => {
  try {
    const query = normalizeName(req.query?.q);
    if (!query) return res.json({ suggestions: [] });
    const suggestions = await buildNameSuggestions(query, 10);
    return res.json({ suggestions });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load name suggestions.", error: error.message });
  }
});

router.post("/checkVisitor", async (req, res) => {
  try {
    const name = normalizeName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);

    if (!name && !phone) {
      return res.status(400).json({ message: "Enter either name or phone number." });
    }

    const suggestions = name ? await buildNameSuggestions(name, 8) : [];
    const exactNameFilter = name ? { name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } } : {};

    if (name && phone) {
      const exactMatch = await Visitor.findOne({ ...exactNameFilter, phone }).sort({ createdAt: -1 });
      if (exactMatch) {
        return res.json({
          exists: true,
          phoneMatch: true,
          message: "User already exists. Please renew gate pass.",
          visitor: exactMatch,
          suggestions,
        });
      }

      const phoneMatch = await Visitor.findOne({ phone }).sort({ createdAt: -1 });
      if (phoneMatch) {
        return res.json({
          exists: true,
          phoneMatch: true,
          message: "User exists. Renew pass for today?",
          visitor: phoneMatch,
          suggestions,
        });
      }

      const nameOnlyMatch = await Visitor.findOne(exactNameFilter).sort({ createdAt: -1 });
      if (nameOnlyMatch) {
        return res.json({
          exists: true,
          phoneMatch: false,
          message: "Name exists. Verify phone or renew pass.",
          visitor: nameOnlyMatch,
          suggestions,
        });
      }

      return res.json({
        exists: false,
        phoneMatch: false,
        message: suggestions.length ? "No exact match. Select from suggestions or create gate pass." : "New visitor. Create gate pass.",
        visitor: null,
        suggestions,
      });
    }

    if (phone) {
      const phoneMatch = await Visitor.findOne({ phone }).sort({ createdAt: -1 });
      if (phoneMatch) {
        return res.json({
          exists: true,
          phoneMatch: true,
          message: "User exists. Validate pass.",
          visitor: phoneMatch,
          suggestions,
        });
      }

      return res.json({
        exists: false,
        phoneMatch: false,
        message: "New visitor. Create gate pass.",
        visitor: null,
        suggestions,
      });
    }

    const nameOnlyMatch = await Visitor.findOne(exactNameFilter).sort({ createdAt: -1 });
    if (nameOnlyMatch) {
      return res.json({
        exists: true,
        phoneMatch: false,
        message: "User exists. Validate pass.",
        visitor: nameOnlyMatch,
        suggestions,
      });
    }

    return res.json({
      exists: false,
      phoneMatch: false,
      message: suggestions.length ? "No exact match. Select from suggestions or create gate pass." : "New visitor. Create gate pass.",
      visitor: null,
      suggestions,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to check visitor.", error: error.message });
  }
});

router.post("/createPass", async (req, res) => {
  try {
    const { adminPassword } = req.body || {};

    if (String(adminPassword || "") !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const payload = buildVisitorPayload(req.body || {});
    await ensureNewPassAllowed(payload);

    const now = new Date();
    const passId = await generateVisitorPassId("PASS");
    const qrPayload = buildPassQrPayload(passId, payload.phone);

    const visitor = await Visitor.create({
      ...payload,
      qrPayload,
      passId,
      status: "active",
      approvalStatus: "approved",
      approvalRecipient: "",
      approvalToken: "",
      approvalRequestedAt: null,
      approvalDecisionAt: now,
      approvalEmailSentAt: null,
      date: now,
      timeIn: now,
      timeOut: null,
    });

    let qrCodeDataUrl = "";
    try {
      qrCodeDataUrl = await createQrDataUrl(qrPayload);
    } catch (error) {
      console.error("Failed to generate QR code for pass:", error.message);
    }

    return res.status(201).json({
      success: true,
      message: "Gate pass issued",
      passId: visitor.passId,
      qrCodeDataUrl,
      visitor,
    });
  } catch (error) {
    if (error.status === 409) {
      return res.status(409).json({
        success: false,
        code: error.code || "RENEW_REQUIRED",
        message: error.message,
        visitor: error.visitor || null,
      });
    }
    if (error.status === 400) {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: "Failed to create gate pass.", error: error.message });
  }
});

router.post("/requestApproval", async (req, res) => {
  try {
    if (!isApprovalEmailConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Approval email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and approval email settings first.",
      });
    }

    const payload = buildVisitorPayload(req.body || {});
    await ensureNewPassAllowed(payload);

    const now = new Date();
    const passId = await generateVisitorPassId("PASS");
    const qrPayload = buildPassQrPayload(passId, payload.phone);
    const approvalToken = crypto.randomBytes(24).toString("hex");
    const approvalRecipient = getApprovalRecipient();

    const visitor = await Visitor.create({
      ...payload,
      qrPayload,
      passId,
      status: "pending",
      approvalStatus: "pending",
      approvalToken,
      approvalRecipient,
      approvalRequestedAt: now,
      approvalDecisionAt: null,
      approvalEmailSentAt: null,
      date: now,
      timeIn: now,
      timeOut: null,
    });

    try {
      const baseUrl = getBaseUrl(req);
      const allowUrl = `${baseUrl}/api/approval/respond?token=${encodeURIComponent(approvalToken)}&decision=allow`;
      const denyUrl = `${baseUrl}/api/approval/respond?token=${encodeURIComponent(approvalToken)}&decision=deny`;
      const transporter = getApprovalTransporter();

      await transporter.sendMail({
        from: String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim(),
        to: approvalRecipient,
        subject: `Visitor approval required: ${visitor.name} (${visitor.passId})`,
        text: buildApprovalEmailText({ visitor, allowUrl, denyUrl }),
        html: buildApprovalEmailHtml({ visitor, allowUrl, denyUrl }),
      });

      visitor.approvalEmailSentAt = new Date();
      await visitor.save();
    } catch (error) {
      await Visitor.deleteOne({ _id: visitor._id });
      return res.status(500).json({
        success: false,
        message: "Failed to send approval email.",
        error: error.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: `Approval email sent to ${approvalRecipient}. Waiting for decision.`,
      passId: visitor.passId,
      visitor,
    });
  } catch (error) {
    if (error.status === 409) {
      return res.status(409).json({
        success: false,
        code: error.code || "RENEW_REQUIRED",
        message: error.message,
        visitor: error.visitor || null,
      });
    }
    if (error.status === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to create approval request.", error: error.message });
  }
});

router.get("/approval/respond", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    const decision = String(req.query?.decision || "").trim().toLowerCase();

    if (!token || !["allow", "deny"].includes(decision)) {
      return res
        .status(400)
        .type("html")
        .send(
          renderApprovalDecisionPage({
            title: "Approval Link Invalid",
            message: "This approval link is invalid or incomplete.",
            visitor: null,
            decision: "denied",
          })
        );
    }

    const visitor = await Visitor.findOne({ approvalToken: token }).sort({ createdAt: -1 });
    if (!visitor) {
      return res
        .status(404)
        .type("html")
        .send(
          renderApprovalDecisionPage({
            title: "Approval Request Not Found",
            message: "This approval request could not be found. It may have been removed or already processed.",
            visitor: null,
            decision: "denied",
          })
        );
    }

    const now = new Date();
    const currentApprovalStatus = String(visitor.approvalStatus || "approved").toLowerCase();

    if (decision === "allow") {
      visitor.approvalStatus = "approved";
      visitor.approvalDecisionAt = now;
      if (["pending", "denied"].includes(String(visitor.status || "").toLowerCase())) {
        visitor.status = "active";
      }
    } else {
      visitor.approvalStatus = "denied";
      visitor.approvalDecisionAt = now;
      if (String(visitor.status || "").toLowerCase() !== "completed") {
        visitor.status = "denied";
      }
    }

    await visitor.save();

    const repeatedAction =
      (decision === "allow" && currentApprovalStatus === "approved") ||
      (decision === "deny" && currentApprovalStatus === "denied");

    return res
      .status(200)
      .type("html")
      .send(
        renderApprovalDecisionPage({
          title: decision === "allow" ? "Visitor Approved" : "Visitor Denied",
          message: repeatedAction
            ? `This visitor was already marked as ${decision === "allow" ? "approved" : "denied"}.`
            : `The visitor request is now ${decision === "allow" ? "approved" : "denied"}. Refresh the portal to see the latest status.`,
          visitor,
          decision: decision === "allow" ? "approved" : "denied",
        })
      );
  } catch (error) {
    return res
      .status(500)
      .type("html")
      .send(
        renderApprovalDecisionPage({
          title: "Approval Processing Failed",
          message: error.message || "Something went wrong while updating approval status.",
          visitor: null,
          decision: "denied",
        })
      );
  }
});

router.post("/validatePass", async (req, res) => {
  try {
    const passId = String(req.body?.passId || "").trim().toUpperCase();
    const phone = normalizePhone(req.body?.phone);

    if (!passId) {
      return res.status(400).json({ valid: false, message: "Pass ID is required." });
    }

    const query = { passId };
    if (phone) query.phone = phone;

    const visitor = await Visitor.findOne(query).sort({ createdAt: -1 });
    if (!visitor) {
      return res.status(404).json({ valid: false, message: "Pass not found." });
    }

    const approvalStatus = String(visitor.approvalStatus || "approved").toLowerCase();
    if (approvalStatus === "pending") {
      return res.status(403).json({ valid: false, message: "Approval is still pending for this pass." });
    }

    if (approvalStatus === "denied") {
      return res.status(403).json({ valid: false, message: "This pass request was denied." });
    }

    if (visitor.status !== "active") {
      return res.status(400).json({ valid: false, message: "Pass is not active." });
    }

    return res.json({
      valid: true,
      message: "User authenticated",
      visitor,
    });
  } catch (error) {
    return res.status(500).json({ valid: false, message: "Failed to validate pass.", error: error.message });
  }
});

router.post("/markExit", async (req, res) => {
  try {
    const passId = String(req.body?.passId || "").trim().toUpperCase();
    const phone = normalizePhone(req.body?.phone);

    if (!passId) {
      return res.status(400).json({ success: false, message: "Pass ID is required." });
    }

    const query = { passId };
    if (phone) query.phone = phone;

    const visitor = await Visitor.findOne(query).sort({ createdAt: -1 });
    if (!visitor) {
      return res.status(404).json({ success: false, message: "Pass not found." });
    }

    if (String(visitor.status).toLowerCase() === "completed") {
      return res.json({
        success: true,
        message: "Exit already marked.",
        visitor,
      });
    }

    if (String(visitor.approvalStatus || "approved").toLowerCase() === "pending") {
      return res.status(400).json({
        success: false,
        message: "Approval is still pending. Exit cannot be marked yet.",
      });
    }

    if (String(visitor.approvalStatus || "approved").toLowerCase() === "denied") {
      return res.status(400).json({
        success: false,
        message: "This pass was denied and cannot be checked out.",
      });
    }

    visitor.status = "completed";
    visitor.timeOut = new Date();
    await visitor.save();

    return res.json({
      success: true,
      message: "Exit marked successfully.",
      visitor,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to mark exit.", error: error.message });
  }
});

router.post("/renewPass", async (req, res) => {
  try {
    const adminPassword = String(req.body?.adminPassword || "").trim();
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const name = normalizeName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);

    if (!name && !phone) {
      return res.status(400).json({ success: false, message: "Enter name or phone to renew pass." });
    }

    const query = {};
    if (name && phone) {
      query.name = { $regex: `^${escapeRegex(name)}$`, $options: "i" };
      query.phone = phone;
    } else if (phone) {
      query.phone = phone;
    } else {
      query.name = { $regex: `^${escapeRegex(name)}$`, $options: "i" };
    }

    const existingVisitor = await Visitor.findOne(query).sort({ createdAt: -1 });
    if (!existingVisitor) {
      return res.status(404).json({ success: false, message: "No existing pass history found for this person." });
    }

    const now = new Date();
    const passId = await generateVisitorPassId("PASS");
    const qrPayload = buildPassQrPayload(passId, existingVisitor.phone);

    const renewedVisitor = await Visitor.create({
      name: normalizeName(existingVisitor.name),
      phone: normalizePhone(existingVisitor.phone),
      visitorType: normalizeVisitorType(existingVisitor.visitorType),
      companyType: normalizeCompanyType(existingVisitor.companyType),
      company: String(existingVisitor.company || "").trim(),
      ricoUnit: normalizeRicoUnit(existingVisitor.ricoUnit),
      visitType: String(existingVisitor.visitType || "").trim(),
      personToMeet: String(existingVisitor.personToMeet || "").trim(),
      department: normalizeDepartment(existingVisitor.department),
      idProofType: String(existingVisitor.idProofType || "").trim(),
      idProofNumber: String(existingVisitor.idProofNumber || "").trim(),
      carriesLaptop: Boolean(existingVisitor.carriesLaptop),
      laptopSerialNumber: existingVisitor.carriesLaptop ? String(existingVisitor.laptopSerialNumber || "").trim() : "",
      remarks: String(existingVisitor.remarks || "").trim(),
      isVip: false,
      vipAccessId: "",
      qrPayload,
      passId,
      status: "active",
      date: now,
      timeIn: now,
      timeOut: null,
    });

    let qrCodeDataUrl = "";
    try {
      qrCodeDataUrl = await createQrDataUrl(qrPayload);
    } catch (error) {
      console.error("Failed to generate QR code for renewed pass:", error.message);
    }

    return res.status(201).json({
      success: true,
      message: "Gate pass renewed",
      passId: renewedVisitor.passId,
      qrCodeDataUrl,
      visitor: renewedVisitor,
      sourceVisitorId: existingVisitor._id,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to renew gate pass.", error: error.message });
  }
});

router.get("/activePasses", async (req, res) => {
  try {
    const adminPassword = getAdminPassword(req);
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const visitors = await Visitor.find({
      $or: [
        { status: { $regex: /^active$/i } },
        { timeOut: null, status: { $not: /^completed$/i } },
      ],
    })
      .sort({ timeIn: 1, createdAt: 1 })
      .lean();

    return res.json({
      success: true,
      count: visitors.length,
      visitors,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch active passes.", error: error.message });
  }
});

async function handleDeletePass(passIdRaw, adminPasswordRaw, res) {
  try {
    const passId = String(passIdRaw || "").trim().toUpperCase();
    const adminPassword = String(adminPasswordRaw || "").trim();

    if (!passId) {
      return res.status(400).json({ success: false, message: "Pass ID is required." });
    }

    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const deletedVisitor = await Visitor.findOneAndDelete({ passId });
    if (!deletedVisitor) {
      return res.status(404).json({ success: false, message: "Pass not found." });
    }

    return res.json({
      success: true,
      message: "Pass deleted successfully",
      passId,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to delete pass.", error: error.message });
  }
}

router.delete("/pass/:passId", async (req, res) => {
  return handleDeletePass(req.params?.passId, getAdminPassword(req), res);
});

router.post("/deletePass", async (req, res) => {
  return handleDeletePass(req.body?.passId, getAdminPassword(req), res);
});

router.get("/todayVisitors", async (_req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const visitors = await Visitor.find({
      date: { $gte: start, $lt: end },
    }).sort({ timeIn: -1 });

    return res.json({
      count: visitors.length,
      visitors,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch today's visitors.", error: error.message });
  }
});

router.get("/passHistory", async (req, res) => {
  try {
    const adminPassword = getAdminPassword(req);
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const rangeRaw = Number.parseInt(String(req.query?.rangeDays || ""), 10);
    const rangeDays = Number.isFinite(rangeRaw) ? Math.min(Math.max(rangeRaw, 1), 3650) : null;

    const fromDateRaw = String(req.query?.fromDate || "").trim();
    const toDateRaw = String(req.query?.toDate || "").trim();

    let start = null;
    let end = null;

    if (fromDateRaw || toDateRaw) {
      if (!fromDateRaw || !toDateRaw) {
        return res.status(400).json({ success: false, message: "Both FROM and TO dates are required." });
      }

      start = parseDateStart(fromDateRaw);
      end = parseDateEnd(toDateRaw);

      if (!start || !end) {
        return res.status(400).json({ success: false, message: "Enter valid FROM and TO dates." });
      }

      if (start > end) {
        return res.status(400).json({ success: false, message: "FROM date cannot be after TO date." });
      }
    } else if (rangeDays) {
      end = new Date();
      end.setHours(23, 59, 59, 999);
      start = new Date(end);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (rangeDays - 1));
    }

    const query = {};
    if (start || end) {
      const timeFilter = {};
      if (start) timeFilter.$gte = start;
      if (end) timeFilter.$lte = end;

      query.$or = [{ date: timeFilter }, { timeIn: timeFilter }, { createdAt: timeFilter }];
    }

    const visitors = await Visitor.find(query).sort({ timeIn: -1, createdAt: -1 }).lean();

    return res.json({
      success: true,
      count: visitors.length,
      visitors,
      filters: {
        rangeDays,
        fromDate: fromDateRaw || null,
        toDate: toDateRaw || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch pass history.", error: error.message });
  }
});

router.get("/analytics", async (req, res) => {
  try {
    const requestedRange = Number.parseInt(String(req.query?.rangeDays || "7"), 10);
    const rangeDays = ALLOWED_ANALYTIC_RANGES.has(requestedRange) ? requestedRange : 7;

    const { start, end } = analyticsRangeWindow(rangeDays);

    const visitors = await Visitor.find({
      $or: [{ timeIn: { $gte: start, $lte: end } }, { date: { $gte: start, $lte: end } }],
    })
      .select("date timeIn department status")
      .lean();

    const trendKeyToCount = new Map();
    const labels = [];
    const trendCounts = [];

    for (let i = 0; i < rangeDays; i += 1) {
      const date = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      const key = analyticsLocalDateKey(date);
      labels.push(analyticsHumanDayLabel(date));
      trendKeyToCount.set(key, 0);
    }

    const hourCounts = new Array(24).fill(0);
    const departmentToCount = new Map(DEPARTMENT_OPTIONS.map((item) => [item, 0]));
    let activePasses = 0;

    for (const visitor of visitors) {
      if (String(visitor.status).toLowerCase() === "active") {
        activePasses += 1;
      }

      const arrivalTime = visitor.timeIn || visitor.date;
      if (arrivalTime) {
        const key = analyticsLocalDateKey(arrivalTime);
        if (trendKeyToCount.has(key)) {
          trendKeyToCount.set(key, (trendKeyToCount.get(key) || 0) + 1);
        }

        const hour = analyticsHourOfArrival(arrivalTime);
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
          hourCounts[hour] += 1;
        }
      }

      const department = normalizeDepartment(visitor.department) || "Other";
      if (!departmentToCount.has(department)) {
        departmentToCount.set(department, 0);
      }
      departmentToCount.set(department, (departmentToCount.get(department) || 0) + 1);
    }

    for (const key of trendKeyToCount.keys()) {
      trendCounts.push(trendKeyToCount.get(key) || 0);
    }

    const peakCount = Math.max(...hourCounts);
    const peakHourIndex = hourCounts.indexOf(peakCount);
    const peakHour = peakCount > 0 ? { hour: peakHourIndex, label: hourLabel(peakHourIndex), count: peakCount } : { hour: null, label: "-", count: 0 };

    const peakHoursLabels = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
    const departmentLabels = Array.from(departmentToCount.keys());
    const departmentCounts = Array.from(departmentToCount.values());

    return res.json({
      rangeDays,
      totalVisitors: visitors.length,
      activePasses,
      peakHour,
      trend: {
        labels,
        counts: trendCounts,
      },
      peakHours: {
        labels: peakHoursLabels,
        counts: hourCounts,
      },
      departments: {
        labels: departmentLabels,
        counts: departmentCounts,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load analytics.", error: error.message });
  }
});

router.post("/vip/generate", async (req, res) => {
  try {
    const adminPassword = String(req.body?.adminPassword || "").trim();
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const label = String(req.body?.label || "VIP").trim() || "VIP";
    const vipAccessId = await generateVipAccessId();

    const vipPass = await VipPass.create({
      vipAccessId,
      label,
      status: "active",
    });

    return res.status(201).json({
      success: true,
      message: "VIP pass ID generated",
      vipAccessId,
      vipPass,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to generate VIP pass ID.", error: error.message });
  }
});

router.post("/vip/issue", async (req, res) => {
  try {
    const vipAccessId = String(req.body?.vipAccessId || "").trim().toUpperCase();
    if (!vipAccessId) {
      return res.status(400).json({ success: false, message: "VIP pass ID is required." });
    }

    const vipPass = await VipPass.findOne({ vipAccessId, status: "active" });
    if (!vipPass) {
      return res.status(404).json({ success: false, message: "VIP pass ID not found or inactive." });
    }

    const now = new Date();
    const passId = await generateVisitorPassId("VIP");
    const phone = await generateVipPhone();
    const qrPayload = buildPassQrPayload(passId, phone);

    const visitor = await Visitor.create({
      name: vipPass.label ? `VIP Visitor - ${vipPass.label}` : "VIP Visitor",
      phone,
      visitorType: "Visitor",
      companyType: "RICO",
      company: "RICO",
      ricoUnit: VIP_DEFAULT_UNIT,
      visitType: "VIP Visit",
      personToMeet: "Management",
      department: VIP_DEFAULT_DEPARTMENT,
      idProofType: "VIP PASS",
      idProofNumber: vipAccessId,
      carriesLaptop: false,
      laptopSerialNumber: "",
      remarks: "VIP auto entry",
      isVip: true,
      vipAccessId,
      qrPayload,
      passId,
      status: "active",
      date: now,
      timeIn: now,
      timeOut: null,
    });

    let qrCodeDataUrl = "";
    try {
      qrCodeDataUrl = await createQrDataUrl(qrPayload);
    } catch (error) {
      console.error("Failed to generate QR code for VIP pass:", error.message);
    }

    vipPass.issueCount = (vipPass.issueCount || 0) + 1;
    vipPass.lastIssuedPassId = passId;
    vipPass.lastIssuedAt = now;
    await vipPass.save();

    return res.status(201).json({
      success: true,
      message: "Gate pass issued",
      passId,
      vipAccessId,
      qrCodeDataUrl,
      visitor,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to issue VIP gate pass.", error: error.message });
  }
});

router.post("/vip/verify", async (req, res) => {
  try {
    const passId = String(req.body?.passId || "").trim().toUpperCase();
    const vipAccessId = String(req.body?.vipAccessId || "").trim().toUpperCase();

    if (!passId && !vipAccessId) {
      return res.status(400).json({ success: false, message: "Enter pass ID or VIP pass ID." });
    }

    const query = { isVip: true };
    if (passId) {
      query.passId = passId;
    } else {
      query.vipAccessId = vipAccessId;
    }

    const visitor = await Visitor.findOne(query).sort({ timeIn: -1 });
    if (!visitor) {
      return res.status(404).json({ success: false, message: "VIP visit record not found." });
    }

    return res.json({
      success: true,
      visitor,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to verify VIP entry.", error: error.message });
  }
});

router.post("/vip/checkout", async (req, res) => {
  try {
    const passId = String(req.body?.passId || "").trim().toUpperCase();
    const vipAccessId = String(req.body?.vipAccessId || "").trim().toUpperCase();

    if (!passId && !vipAccessId) {
      return res.status(400).json({ success: false, message: "Enter pass ID or VIP pass ID." });
    }

    const query = { isVip: true, status: "active" };
    if (passId) {
      query.passId = passId;
    } else {
      query.vipAccessId = vipAccessId;
    }

    const visitor = await Visitor.findOne(query).sort({ timeIn: -1 });
    if (!visitor) {
      return res.status(404).json({ success: false, message: "Active VIP visit not found." });
    }

    visitor.status = "completed";
    visitor.timeOut = new Date();
    await visitor.save();

    return res.json({
      success: true,
      message: "VIP visitor checked out",
      visitor,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to complete VIP checkout.", error: error.message });
  }
});

router.get("/vip/logs", async (req, res) => {
  try {
    const limitRaw = Number.parseInt(String(req.query?.limit || "30"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 30;

    const visitors = await Visitor.find({ isVip: true })
      .sort({ timeIn: -1 })
      .limit(limit)
      .select("name passId vipAccessId status timeIn timeOut")
      .lean();

    return res.json({
      count: visitors.length,
      visitors,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load VIP logs.", error: error.message });
  }
});

module.exports = router;
