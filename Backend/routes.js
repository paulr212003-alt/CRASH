const express = require("express");
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
const ANALYTICS_UTC_OFFSET_MINUTES = Number.parseInt(
  String(process.env.ANALYTICS_UTC_OFFSET_MINUTES || "330"),
  10
);
const ANALYTICS_OFFSET_MS = (Number.isFinite(ANALYTICS_UTC_OFFSET_MINUTES) ? ANALYTICS_UTC_OFFSET_MINUTES : 330) * 60 * 1000;

const normalizePhone = (phone = "") => String(phone).replace(/\D/g, "");
const normalizeName = (name = "") => String(name).trim().replace(/\s+/g, " ");

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
      adminPassword,
    } = req.body || {};

    if (String(adminPassword || "") !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

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
      return res.status(400).json({ message: `Missing required fields: ${missing.join(", ")}` });
    }

    if (payload.companyType === "RICO" && payload.ricoUnit && !RICO_UNITS.includes(payload.ricoUnit)) {
      return res.status(400).json({ message: "Select a valid RICO unit." });
    }

    if (payload.companyType !== "RICO") {
      payload.ricoUnit = "";
    }

    if (payload.department && !DEPARTMENT_OPTIONS.includes(payload.department)) {
      return res.status(400).json({ message: "Select a valid department." });
    }

    if (!payload.carriesLaptop) {
      payload.laptopSerialNumber = "";
    }

    const exactNameFilter = {
      name: { $regex: `^${escapeRegex(payload.name)}$`, $options: "i" },
    };

    const exactNamePhoneMatch = await Visitor.findOne({
      ...exactNameFilter,
      phone: payload.phone,
    }).sort({ createdAt: -1 });

    if (exactNamePhoneMatch) {
      return res.status(409).json({
        success: false,
        code: "RENEW_REQUIRED",
        message: "Same name and phone already exists. Kindly renew pass for this individual.",
        visitor: exactNamePhoneMatch,
      });
    }

    const now = new Date();
    const passId = await generateVisitorPassId("PASS");
    const qrPayload = buildPassQrPayload(passId, payload.phone);

    const visitor = await Visitor.create({
      ...payload,
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
    return res.status(500).json({ message: "Failed to create gate pass.", error: error.message });
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
