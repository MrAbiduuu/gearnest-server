/**
 * MongoDB aggregations for the admin Platform Control Center.
 *
 * Every number returned here is calculated from the database. The Express
 * routes that call these helpers are protected by `authenticate` and
 * `requireAdmin`, so regular users can never reach the data.
 */
const USER_COLLECTION = "user";
const EQUIPMENT_COLLECTION = "equipments";
const PURCHASE_COLLECTION = "purchases";
const LATEST_BOOKING_LIMIT = 8;

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

const CHART_INCLUDED_STATUSES = [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
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

const stringExpression = (field, fallback) => ({
  $convert: {
    input: `$${field}`,
    to: "string",
    onError: fallback,
    onNull: fallback,
  },
});

const lowerStatus = { $toLower: stringExpression("status", "") };
const lowerPaymentStatus = {
  $toLower: stringExpression("paymentStatus", "paid"),
};
const lowerRole = { $toLower: stringExpression("role", "customer") };
const lowerEquipmentStatus = { $toLower: stringExpression("status", "") };

const createdAtDateExpression = {
  $convert: {
    input: "$createdAt",
    to: "date",
    onError: null,
    onNull: null,
  },
};

const isDeletedBooking = {
  $in: [lowerStatus, ["deleted", "invalid"]],
};

const bookingStatusExpression = {
  $switch: {
    branches: [
      { case: { $eq: [lowerStatus, "pending"] }, then: "pending" },
      {
        case: { $in: [lowerStatus, ["completed", "complete"]] },
        then: "completed",
      },
      {
        case: { $in: [lowerStatus, ["cancelled", "canceled"]] },
        then: "cancelled",
      },
    ],
    default: "confirmed",
  },
};

const paymentStatusExpression = {
  $switch: {
    branches: [
      { case: { $eq: [lowerPaymentStatus, "unpaid"] }, then: "unpaid" },
      {
        case: {
          $or: [
            { $eq: [lowerPaymentStatus, "refunded"] },
            { $ne: [{ $ifNull: ["$refundedAt", null] }, null] },
          ],
        },
        then: "refunded",
      },
    ],
    default: "paid",
  },
};

/**
 * Purchases are written only after Stripe confirms a paid session. Refunds,
 * unpaid records and cancelled/deleted bookings are excluded from revenue.
 */
const successfulPaymentExpression = {
  $and: [
    {
      $not: {
        $in: [lowerStatus, REVENUE_EXCLUDED_BOOKING_STATUSES],
      },
    },
    {
      $not: {
        $in: [lowerPaymentStatus, REVENUE_EXCLUDED_PAYMENT_STATUSES],
      },
    },
    { $eq: [{ $ifNull: ["$refundedAt", null] }, null] },
    { $isNumber: "$amountTotal" },
    { $gt: ["$amountTotal", 0] },
  ],
};

const toStringExpression = (field) => ({
  $convert: {
    input: `$${field}`,
    to: "string",
    onError: "",
    onNull: "",
  },
});

const currencyExpression = {
  $toUpper: stringExpression("currency", "BDT"),
};

/** Stable payment identity: one Stripe Checkout Session is one transaction. */
const paymentKeyExpression = {
  $cond: [
    { $gt: [{ $strLenCP: stringExpression("stripeSessionId", "") }, 0] },
    { $concat: ["session:", stringExpression("stripeSessionId", "")] },
    { $concat: ["purchase:", stringExpression("_id", "")] },
  ],
};

const count = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const parseAnalyticsYear = (value) => {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  const currentYear = new Date().getUTCFullYear();
  if (year < 1900 || year > currentYear + 1) return null;
  return year;
};

export const getAdminAnalyticsOverview = async (database) => {
  const users = database.collection(USER_COLLECTION);
  const equipments = database.collection(EQUIPMENT_COLLECTION);
  const purchases = database.collection(PURCHASE_COLLECTION);

  const [roleRows, equipmentRows] = await Promise.all([
    users
      .aggregate([
        {
          $group: {
            _id: {
              $switch: {
                branches: [
                  { case: { $eq: [lowerRole, "owner"] }, then: "owner" },
                  { case: { $eq: [lowerRole, "admin"] }, then: "admin" },
                ],
                default: "customer",
              },
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    equipments
      .aggregate([
        {
          $group: {
            _id: {
              $switch: {
                branches: [
                  {
                    case: { $eq: [lowerEquipmentStatus, "pending"] },
                    then: "pending",
                  },
                  {
                    case: { $eq: [lowerEquipmentStatus, "rejected"] },
                    then: "rejected",
                  },
                ],
                // Legacy listings predate the status field and are live.
                default: "approved",
              },
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
  ]);

  const roleCounts = { customer: 0, owner: 0, admin: 0 };
  for (const row of roleRows) {
    if (row._id in roleCounts) roleCounts[row._id] = count(row.count);
  }

  const equipmentCounts = { approved: 0, pending: 0, rejected: 0 };
  for (const row of equipmentRows) {
    if (row._id in equipmentCounts) equipmentCounts[row._id] = count(row.count);
  }

  const [purchaseResult] = await purchases
    .aggregate([
      { $match: { $expr: { $not: isDeletedBooking } } },
      {
        $addFields: {
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
                confirmedBookings: {
                  $sum: {
                    $cond: [{ $eq: ["$bookingStatus", "confirmed"] }, 1, 0],
                  },
                },
                pendingBookings: {
                  $sum: {
                    $cond: [{ $eq: ["$bookingStatus", "pending"] }, 1, 0],
                  },
                },
                completedBookings: {
                  $sum: {
                    $cond: [{ $eq: ["$bookingStatus", "completed"] }, 1, 0],
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
              $group: {
                _id: "$currency",
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 1 },
          ],
          latest: [
            { $sort: { createdAtDate: -1 } },
            { $limit: LATEST_BOOKING_LIMIT },
            {
              $lookup: {
                from: USER_COLLECTION,
                let: { userId: toStringExpression("userId") },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $eq: [toStringExpression("_id"), "$$userId"],
                      },
                    },
                  },
                  { $project: { name: 1, email: 1, _id: 0 } },
                  { $limit: 1 },
                ],
                as: "renter",
              },
            },
            {
              $lookup: {
                from: EQUIPMENT_COLLECTION,
                let: { equipmentId: toStringExpression("equipmentId") },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $eq: [toStringExpression("_id"), "$$equipmentId"],
                      },
                    },
                  },
                  { $project: { name: 1, image: 1, images: 1, _id: 0 } },
                  { $limit: 1 },
                ],
                as: "equipment",
              },
            },
            {
              $project: {
                _id: toStringExpression("_id"),
                equipmentId: toStringExpression("equipmentId"),
                equipmentName: {
                  $ifNull: [
                    { $arrayElemAt: ["$equipment.name", 0] },
                    "Equipment unavailable",
                  ],
                },
                equipmentImage: {
                  $ifNull: [
                    { $arrayElemAt: ["$equipment.image", 0] },
                    {
                      $ifNull: [
                        { $arrayElemAt: ["$equipment.images", 0] },
                        null,
                      ],
                    },
                    null,
                  ],
                },
                renterName: {
                  $ifNull: [
                    { $arrayElemAt: ["$renter.name", 0] },
                    "Renter unavailable",
                  ],
                },
                renterEmail: {
                  $ifNull: [
                    { $arrayElemAt: ["$renter.email", 0] },
                    "Email unavailable",
                  ],
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
                createdAt: {
                  $dateToString: {
                    date: "$createdAtDate",
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

  const summary = purchaseResult?.bookings?.[0];
  const paymentSummary = purchaseResult?.payments?.[0];
  const revenueCurrency = purchaseResult?.currency?.[0]?._id || "BDT";

  const latestBookings = (purchaseResult?.latest ?? []).map((booking) => ({
    id: String(booking._id ?? ""),
    equipmentId: booking.equipmentId ?? "",
    equipmentName: booking.equipmentName || "Equipment unavailable",
    equipmentImage: booking.equipmentImage || undefined,
    renterName: booking.renterName || "Renter unavailable",
    renterEmail: booking.renterEmail || "Email unavailable",
    totalAmount: count(booking.totalAmount),
    currency: booking.currency || revenueCurrency,
    status: booking.status || "confirmed",
    paymentStatus: booking.paymentStatus || "paid",
    createdAt: booking.createdAt ?? undefined,
  }));

  return {
    totalUsers: roleCounts.customer + roleCounts.owner + roleCounts.admin,
    totalOwners: roleCounts.owner,
    totalRenters: roleCounts.customer,
    totalEquipment:
      equipmentCounts.approved + equipmentCounts.pending + equipmentCounts.rejected,
    approvedEquipment: equipmentCounts.approved,
    pendingEquipment: equipmentCounts.pending,
    totalBookings: count(summary?.totalBookings),
    confirmedBookings: count(summary?.confirmedBookings),
    completedBookings: count(summary?.completedBookings),
    pendingBookings: count(summary?.pendingBookings),
    paidTransactions: count(paymentSummary?.paidTransactions),
    totalRevenue: count(paymentSummary?.revenueMinorUnits) / 100,
    currency: revenueCurrency,
    latestBookings,
  };
};

export const getAdminMonthlyBookings = async (database, year) => {
  const purchases = database.collection(PURCHASE_COLLECTION);
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const currentYear = new Date().getUTCFullYear();

  const [result] = await purchases
    .aggregate([
      { $addFields: { createdAtDate: createdAtDateExpression } },
      { $match: { $expr: { $not: isDeletedBooking } } },
      {
        $facet: {
          years: [
            { $match: { createdAtDate: { $ne: null } } },
            { $group: { _id: { $year: "$createdAtDate" } } },
            { $sort: { _id: -1 } },
          ],
          monthly: [
            { $match: { createdAtDate: { $gte: start, $lt: end } } },
            {
              $group: {
                _id: { $month: "$createdAtDate" },
                totalBookings: { $sum: 1 },
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

  const monthlyCounts = new Map();
  for (const row of result?.monthly ?? []) {
    monthlyCounts.set(row._id, count(row.totalBookings));
  }

  return {
    year,
    availableYears: [...years].sort((a, b) => b - a),
    monthlyBookings: MONTH_LABELS.map((month, index) => ({
      month,
      monthNumber: index + 1,
      totalBookings: monthlyCounts.get(index + 1) ?? 0,
    })),
    bookingStatusesIncluded: CHART_INCLUDED_STATUSES,
  };
};

/**
 * Monthly gross paid rental volume for the selected year.
 *
 * Purchases are written only after Stripe confirms a paid Checkout Session, so
 * `createdAt` is the closest available payment completion date. The pipeline
 * deduplicates by `stripeSessionId` before grouping by month and never mixes
 * currencies in the chart: the dominant actual currency from the records is
 * returned with the series.
 */
export const getAdminMonthlyRevenue = async (database, year) => {
  const purchases = database.collection(PURCHASE_COLLECTION);
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const currentYear = new Date().getUTCFullYear();

  const [result] = await purchases
    .aggregate([
      {
        $addFields: {
          createdAtDate: createdAtDateExpression,
          isSuccessfulPayment: successfulPaymentExpression,
          paymentKey: paymentKeyExpression,
        },
      },
      { $match: { isSuccessfulPayment: true, createdAtDate: { $ne: null } } },
      {
        // One Stripe session must never be counted more than once.
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
  const currency = currencyRows[0]?._id || "BDT";
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
    /** Actual currency stored on the payment records used by the series. */
    currency,
    currencyBreakdown: currencyRows.map((row) => ({
      currency: row._id || "BDT",
      transactions: count(row.transactions),
      totalRevenue: count(row.amountMinor) / 100,
    })),
    timezone: "UTC",
    revenueBasis:
      "Gross paid rental volume from verified purchases, deduplicated by Stripe session and grouped by createdAt.",
    excludedStatuses: {
      payments: REVENUE_EXCLUDED_PAYMENT_STATUSES,
      bookings: REVENUE_EXCLUDED_BOOKING_STATUSES,
    },
  };
};
