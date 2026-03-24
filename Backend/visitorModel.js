const mongoose = require("mongoose");

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

const visitorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    visitorType: {
      type: String,
      enum: VISITOR_TYPE_OPTIONS,
      default: "Visitor",
      trim: true,
      index: true,
    },
    companyType: { type: String, enum: ["RICO", "Other", ""], default: "", trim: true, index: true },
    company: { type: String, default: "", trim: true, index: true },
    ricoUnit: {
      type: String,
      enum: [...RICO_UNITS, ""],
      default: "",
      trim: true,
    },
    visitType: { type: String, required: true, trim: true },
    personToMeet: { type: String, required: true, trim: true },
    department: {
      type: String,
      enum: [...DEPARTMENT_OPTIONS, ""],
      default: "",
      trim: true,
      index: true,
    },
    idProofType: { type: String, default: "", trim: true },
    idProofNumber: { type: String, default: "", trim: true },
    carriesLaptop: { type: Boolean, default: false },
    laptopSerialNumber: { type: String, default: "", trim: true },
    isVip: { type: Boolean, default: false, index: true },
    vipAccessId: { type: String, default: "", trim: true, index: true },
    qrPayload: { type: String, default: "", trim: true, index: true },
    remarks: { type: String, default: "", trim: true },
    passId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["pending", "active", "completed", "denied"],
      default: "active",
      index: true,
    },
    approvalStatus: {
      type: String,
      enum: ["approved", "pending", "denied"],
      default: "approved",
      index: true,
    },
    approvalToken: { type: String, default: "", trim: true, index: true },
    approvalRecipient: { type: String, default: "", trim: true },
    approvalRequestedAt: { type: Date, default: null },
    approvalDecisionAt: { type: Date, default: null },
    approvalEmailSentAt: { type: Date, default: null },
    date: { type: Date, default: Date.now, index: true },
    timeIn: { type: Date, default: Date.now },
    timeOut: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Visitor", visitorSchema, "visitors");
