/**
 * Owner-scoped dashboard aggregations.
 *
 * The owner identity always comes from `req.authUser` (verified Better Auth
 * session + current database role), never from a query parameter or request
 * body. Equipment ownership is stored as `owner.email`, so that verified email
 * is the scoping key. Purchases are joined back to the owner's equipment before
 * any booking or revenue number is calculated.
 */
import { equipmentStatusExpression } from "./equipment-moderation.js";

const USER_COLLECTION = "user";
const EQUIPMENT_COLLECTION = "equipments";
const PURCHASE_COLLECTION = "purchases";
const RECENT_LIMIT = 5;

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const REVENUE_EXCLUDED_PAYMENT_STATUSES = [
  "unpaid",
  "refunded",
  "failed",
  "pending",
];
const REVENUE_EXCLUDED_BOOKING_STATUSES = [
  "cancelled",
  "canceled",
  "deleted",
  "invalid",
];

const count = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const toText = (field) => ({
  $convert: {
    input: `$${field}`,
    to: "string",
    onError: "",
    onNull: "",
  },
});

const lowerText = (field, fallback = "") => ({
  $toLower: {
    $convert: {
      input: `$${field}`,
      to: "string",
      onError: fallback,
      onNull: fallback,
    },
  },
});

const ownerEmail = (authUser) =>
  String(authUser?.email ?? "").trim().toLowerCase();

const createdAtDateExpression = {
  $convert: {
    input: "$createdAt",
    to: "date",
    onError: null,
    onNull: null,
  },
};

const bookingStatusExpression = {
  $switch: {
    branches: [
      { case: { $eq: [lowerText("status"), "pending"] }, then: "pending" },
      {
        case: { $in: [lowerText("status"), ["cancelled", "canceled"]] },
        then: "cancelled",
      },
    ],
    default: "confirmed",
  },
};

const paymentStatusExpression = {
  $switch: {
    branches: [
      { case: { $eq: [lowerText("paymentStatus", "paid"), "unpaid"] }, then: "unpaid" },
      {
        case: {
          $or: [
            { $eq: [lowerText("paymentStatus", "paid"), "refunded"] },
            { $ne: [{ $ifNull: ["$refundedAt", null] }, null] },
          ],
        },
        then: "refunded",
      },
    ],
    default: "paid",
  },
};

const successfulPaymentExpression = {
  $and: [
    {
      $not: {
        $in: [lowerText("status"), REVENUE_EXCLUDED_BOOKING_STATUSES],
      },
    },
    {
      $not: {
        $in: [lowerText("paymentStatus", "paid"), REVENUE_EXCLUDED_PAYMENT_STATUSES],
      },
    },
    { $eq: [{ $ifNull: ["$refundedAt", null] }, null] },
    { $isNumber: "$amountTotal" },
    { $gt: ["$amountTotal", 0] },
  ],
};

const paymentKeyExpression = {
  $cond: [
    { $gt: [{ $strLenCP: toText("stripeSessionId") }, 0] },
    { $concat: ["session:", toText("stripeSessionId")] },
    { $concat: ["purchase:", toText("_id")] },
  ],
};

const currencyExpression = {
  $toUpper: lowerText("currency", "bdt"),
};

const ownerEquipmentMatch = (email) => ({
  $match: {
    $expr: { $eq: [lowerText("owner.email"), email] },
  },
});

/** Join a purchase to the equipment owned by the authenticated owner. */
const ownerEquipmentLookup = (email) => ({
  $lookup: {
    from: EQUIPMENT_COLLECTION,
    let: { equipmentId: toText("equipmentId") },
    pipeline: [
      {
        $match: {
          $expr: {
            $and: [
              { $eq: [toText("_id"), "$$equipmentId"] },
              { $eq: [lowerText("owner.email"), email] },
            ],
          },
        },
      },
      {
        $project: {
          name: 1,
          image: 1,
          images: 1,
          rentalRate: 1,
          rentalPeriod: 1,
          availableStock: 1,
          status: 1,
          createdAt: 1,
        },
      },
      { $limit: 1 },
    ],
    as: "ownerEquipment",
  },
});

const renterLookup = {
  $lookup: {
    from: USER_COLLECTION,
    let: { userId: toText("userId") },
    pipeline: [
      {
        $match: {
          $expr: { $eq: [toText("_id"), "$$userId"] },
        },
      },
      { $project: { name: 1, email: 1, _id: 0 } },
      { $limit: 1 },
    ],
    as: "renter",
  },
};

const equipmentImageExpression = (prefix) => ({
  $ifNull: [
    { $arrayElemAt: [{ $ifNull: [`$${prefix}.images`, []] }, 0] },
    { $ifNull: [`$${prefix}.image`, null] },
    null,
  ],
});

const isoDateExpression = {
  $dateToString: {
    date: "$createdAtDate",
    format: "%Y-%m-%dT%H:%M:%S.%LZ",
    onNull: null,
  },
};

const serializeRecentEquipment = (row) => ({
  id: String(row?._id ?? ""),
  name: row?.name || "Equipment unavailable",
  image: row?.image || row?.images?.[0] || undefined,
  rentalRate: count(row?.rentalRate),
  rentalPeriod: String(row?.rentalPeriod || "daily"),
  availableStock: count(row?.availableStock),
  status: row?.status || "approved",
  createdAt: row?.createdAt ?? undefined,
});

const serializeRecentBooking = (row) => ({
  id: String(row?._id ?? ""),
  equipmentId: String(row?.equipmentId ?? ""),
  equipmentName: row?.equipmentName || "Equipment unavailable",
  equipmentImage: row?.equipmentImage || undefined,
  renterName: row?.renterName || "Renter unavailable",
  renterEmail: row?.renterEmail || "",
  totalAmount: count(row?.totalAmount),
  currency: row?.currency || "BDT",
  status: row?.status || "confirmed",
  paymentStatus: row?.paymentStatus || "paid",
  createdAt: row?.createdAt ?? undefined,
});

/**
 * GET /owner/dashboard/overview data: metrics plus the five most recent
 * bookings and equipment rows, all limited to the authenticated owner.
 */
export const getOwnerDashboardOverview = async (database, authUser) => {
  const email = ownerEmail(authUser);
  const equipments = database.collection(EQUIPMENT_COLLECTION);
  const purchases = database.collection(PURCHASE_COLLECTION);

  const [equipmentResult] = await equipments
    .aggregate([
      ownerEquipmentMatch(email),
      {
        $addFields: {
          normalizedStatus: equipmentStatusExpression,
          availableStockValue: {
            $max: [{ $ifNull: ["$availableStock", 0] }, 0],
          },
        },
      },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalEquipment: { $sum: 1 },
                approvedEquipment: {
                  $sum: {
                    $cond: [{ $eq: ["$normalizedStatus", "approved"] }, 1, 0],
                  },
                },
                pendingEquipment: {
                  $sum: {
                    $cond: [{ $eq: ["$normalizedStatus", "pending"] }, 1, 0],
                  },
                },
                rejectedEquipment: {
                  $sum: {
                    $cond: [{ $eq: ["$normalizedStatus", "rejected"] }, 1, 0],
                  },
                },
                availableEquipment: {
                  $sum: { $cond: [{ $gt: ["$availableStockValue", 0] }, 1, 0] },
                },
                availableStockUnits: {
                  $sum: "$availableStockValue",
                },
              },
            },
          ],
          recent: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: RECENT_LIMIT },
            {
              $project: {
                _id: { $toString: "$_id" },
                name: 1,
                image: 1,
                images: 1,
                rentalRate: 1,
                rentalPeriod: 1,
                availableStock: 1,
                status: "$normalizedStatus",
                createdAt: {
                  $dateToString: {
                    date: { $ifNull: ["$createdAt", null] },
                    format: "%Y-%m-%dT%H:%M:%S.%LZ",
                    onNull: null,
                  },
                },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const [purchaseResult] = await purchases
    .aggregate([
      ownerEquipmentLookup(email),
      { $match: { "ownerEquipment.0": { $exists: true } } },
      {
        $addFields: {
          equipment: { $arrayElemAt: ["$ownerEquipment", 0] },
          createdAtDate: createdAtDateExpression,
          bookingStatus: bookingStatusExpression,
          paymentStatus: paymentStatusExpression,
          isSuccessfulPayment: successfulPaymentExpression,
          paymentKey: paymentKeyExpression,
        },
      },
      {
        $facet: {
          bookings: [
            {
              $group: {
                _id: null,
                totalBookings: { $sum: 1 },
                pendingBookings: {
                  $sum: {
                    $cond: [{ $eq: ["$bookingStatus", "pending"] }, 1, 0],
                  },
                },
                confirmedBookings: {
                  $sum: {
                    $cond: [{ $eq: ["$bookingStatus", "confirmed"] }, 1, 0],
                  },
                },
                cancelledBookings: {
                  $sum: {
                    $cond: [{ $eq: ["$bookingStatus", "cancelled"] }, 1, 0],
                  },
                },
                completedRentals: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$bookingStatus", "confirmed"] },
                          "$isSuccessfulPayment",
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
          payments: [
            { $match: { isSuccessfulPayment: true } },
            {
              $group: {
                _id: "$paymentKey",
                amountMinor: { $max: { $ifNull: ["$amountTotal", 0] } },
              },
            },
            {
              $group: {
                _id: null,
                revenueMinorUnits: { $sum: "$amountMinor" },
                paidTransactions: { $sum: 1 },
              },
            },
          ],
          currency: [
            { $match: { isSuccessfulPayment: true } },
            {
              $group: {
                _id: "$paymentKey",
                currency: { $first: currencyExpression },
              },
            },
            {
              $group: { _id: "$currency", transactions: { $sum: 1 } },
            },
            { $sort: { transactions: -1, _id: 1 } },
            { $limit: 1 },
          ],
          recent: [
            { $sort: { createdAtDate: -1, _id: -1 } },
            { $limit: RECENT_LIMIT },
            renterLookup,
            {
              $project: {
                _id: { $toString: "$_id" },
                equipmentId: { $toString: "$equipmentId" },
                equipmentName: {
                  $ifNull: ["$equipment.name", "Equipment unavailable"],
                },
                equipmentImage: equipmentImageExpression("equipment"),
                renterName: {
                  $ifNull: [
                    { $arrayElemAt: ["$renter.name", 0] },
                    "Renter unavailable",
                  ],
                },
                renterEmail: {
                  $ifNull: [{ $arrayElemAt: ["$renter.email", 0] }, ""],
                },
                totalAmount: {
                  $cond: [
                    { $isNumber: "$amountTotal" },
                    { $divide: ["$amountTotal", 100] },
                    0,
                  ],
                },
                currency: currencyExpression,
                status: "$bookingStatus",
                paymentStatus: "$paymentStatus",
                createdAt: isoDateExpression,
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const equipmentSummary = equipmentResult?.summary?.[0] ?? {};
  const bookingSummary = purchaseResult?.bookings?.[0] ?? {};
  const paymentSummary = purchaseResult?.payments?.[0] ?? {};
  const revenueCurrency = purchaseResult?.currency?.[0]?._id || "BDT";

  return {
    totalEquipment: count(equipmentSummary.totalEquipment),
    approvedEquipment: count(equipmentSummary.approvedEquipment),
    pendingEquipment: count(equipmentSummary.pendingEquipment),
    rejectedEquipment: count(equipmentSummary.rejectedEquipment),
    availableEquipment: count(equipmentSummary.availableEquipment),
    availableStockUnits: count(equipmentSummary.availableStockUnits),
    totalBookings: count(bookingSummary.totalBookings),
    pendingBookings: count(bookingSummary.pendingBookings),
    confirmedBookings: count(bookingSummary.confirmedBookings),
    cancelledBookings: count(bookingSummary.cancelledBookings),
    completedRentals: count(bookingSummary.completedRentals),
    paidTransactions: count(paymentSummary.paidTransactions),
    paidRentalVolume: count(paymentSummary.revenueMinorUnits) / 100,
    currency: revenueCurrency,
    recentBookings: (purchaseResult?.recent ?? []).map(serializeRecentBooking),
    recentEquipment: (equipmentResult?.recent ?? []).map(
      serializeRecentEquipment,
    ),
    definitions: {
      completedRentals:
        "Confirmed bookings with a successful payment. GearNest has no separate completed booking status.",
      paidRentalVolume:
        "Gross successful payment volume for the owner's equipment. No owner payout or commission field is stored.",
      availableEquipment: "Listings with availableStock greater than zero.",
    },
  };
};

/**
 * GET /owner/dashboard/revenue?year=... data. One Stripe session is counted
 * once, and only successful purchases tied to the authenticated owner's
 * equipment are included.
 */
export const getOwnerMonthlyRevenue = async (database, authUser, year) => {
  const email = ownerEmail(authUser);
  const purchases = database.collection(PURCHASE_COLLECTION);
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const currentYear = new Date().getUTCFullYear();

  const [result] = await purchases
    .aggregate([
      ownerEquipmentLookup(email),
      { $match: { "ownerEquipment.0": { $exists: true } } },
      {
        $addFields: {
          createdAtDate: createdAtDateExpression,
          isSuccessfulPayment: successfulPaymentExpression,
          paymentKey: paymentKeyExpression,
        },
      },
      {
        $match: {
          isSuccessfulPayment: true,
          createdAtDate: { $ne: null },
        },
      },
      {
        $group: {
          _id: "$paymentKey",
          amountMinor: { $max: { $ifNull: ["$amountTotal", 0] } },
          currency: { $first: currencyExpression },
          createdAtDate: { $min: "$createdAtDate" },
        },
      },
      {
        $facet: {
          years: [
            { $group: { _id: { $year: "$createdAtDate" } } },
            { $sort: { _id: -1 } },
          ],
          currencies: [
            {
              $group: {
                _id: "$currency",
                transactions: { $sum: 1 },
                amountMinor: { $sum: "$amountMinor" },
              },
            },
            { $sort: { transactions: -1, _id: 1 } },
          ],
          monthly: [
            { $match: { createdAtDate: { $gte: start, $lt: end } } },
            {
              $group: {
                _id: { $month: "$createdAtDate" },
                revenueMinor: { $sum: "$amountMinor" },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const years = new Set([currentYear, year]);
  for (const row of result?.years ?? []) {
    if (Number.isInteger(row._id)) years.add(row._id);
  }

  const currencyRows = result?.currencies ?? [];
  const monthlyAmounts = new Map();
  for (const row of result?.monthly ?? []) {
    monthlyAmounts.set(row._id, count(row.revenueMinor) / 100);
  }

  return {
    year,
    availableYears: [...years].sort((a, b) => b - a),
    monthlyRevenue: MONTH_LABELS.map((month, index) => ({
      month,
      monthNumber: index + 1,
      revenue: monthlyAmounts.get(index + 1) ?? 0,
    })),
    currency: currencyRows[0]?._id || "BDT",
    currencyBreakdown: currencyRows.map((row) => ({
      currency: row._id || "BDT",
      transactions: count(row.transactions),
      totalRevenue: count(row.amountMinor) / 100,
    })),
    timezone: "UTC",
    revenueBasis:
      "Gross paid rental volume from successful purchases tied to the authenticated owner's equipment, deduplicated by Stripe session and grouped by createdAt.",
    excludedStatuses: {
      payments: REVENUE_EXCLUDED_PAYMENT_STATUSES,
      bookings: REVENUE_EXCLUDED_BOOKING_STATUSES,
    },
  };
};
