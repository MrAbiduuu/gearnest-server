/**
 * Customer-scoped dashboard aggregations.
 *
 * The customer identity always comes from `req.authUser`, which Express fills
 * only after verifying the Better Auth session and re-reading the user from the
 * database. No customer ID is accepted from the query string or request body.
 *
 * A booking is a `purchases` document. `amountTotal` is in Stripe minor units
 * and is converted to major units here. All real booking statuses
 * (pending, confirmed, completed, cancelled) are returned to the client.
 */
const USER_COLLECTION = "user";
const EQUIPMENT_COLLECTION = "equipments";
const PURCHASE_COLLECTION = "purchases";
const FAVORITE_COLLECTION = "favorites";
const REVIEW_COLLECTION = "reviews";

const RECENT_LIMIT = 3;
const MAX_RECENT_LIMIT = 5;
const DEFAULT_RECENT_LIMIT = 3;
const BOOKING_STATUSES = ["pending", "confirmed", "completed", "cancelled"];
const BOOKING_PERIODS = [3, 6, 12];
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
const NON_BOOKING_STATUSES = ["deleted", "invalid"];
const HIDDEN_REVIEW_STATUSES = ["hidden", "rejected", "deleted", "removed"];

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

const count = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const toText = (field, fallback = "") => ({
  $convert: {
    input: `$${field}`,
    to: "string",
    onError: fallback,
    onNull: fallback,
  },
});

const lowerText = (field, fallback = "") => ({
  $toLower: toText(field, fallback),
});

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
        case: { $in: [lowerText("status"), ["completed", "complete"]] },
        then: "completed",
      },
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

/** Deleted/invalid rows are not real booking statuses and are never counted. */
const validBookingExpression = {
  $not: { $in: [lowerText("status"), NON_BOOKING_STATUSES] },
};

/** Stripe records a purchase only after a paid checkout session. */
const successfulPaymentExpression = {
  $and: [
    validBookingExpression,
    // A cancelled rental is not money earned, even if checkout once succeeded.
    {
      $not: {
        $in: [lowerText("status"), REVENUE_EXCLUDED_BOOKING_STATUSES],
      },
    },
    {
      $not: {
        $in: [
          lowerText("paymentStatus", "paid"),
          REVENUE_EXCLUDED_PAYMENT_STATUSES,
        ],
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

const isoDateExpression = {
  $dateToString: {
    date: "$createdAtDate",
    format: "%Y-%m-%dT%H:%M:%S.%LZ",
    onNull: null,
  },
};

const equipmentLookup = {
  $lookup: {
    from: EQUIPMENT_COLLECTION,
    let: { equipmentId: toText("equipmentId") },
    pipeline: [
      { $match: { $expr: { $eq: [toText("_id"), "$$equipmentId"] } } },
      { $project: { name: 1, image: 1, images: 1, _id: 0 } },
      { $limit: 1 },
    ],
    as: "equipment",
  },
};

const equipmentImageExpression = {
  $ifNull: [
    "$equipment.image",
    { $arrayElemAt: [{ $ifNull: ["$equipment.images", []] }, 0] },
    null,
  ],
};

const customerMatch = (customerId) => ({
  $match: { userId: customerId, $expr: validBookingExpression },
});

const statusAccumulator = {
  totalBookings: { $sum: 1 },
  pendingBookings: {
    $sum: { $cond: [{ $eq: ["$bookingStatus", "pending"] }, 1, 0] },
  },
  confirmedBookings: {
    $sum: { $cond: [{ $eq: ["$bookingStatus", "confirmed"] }, 1, 0] },
  },
  completedBookings: {
    $sum: { $cond: [{ $eq: ["$bookingStatus", "completed"] }, 1, 0] },
  },
  cancelledBookings: {
    $sum: { $cond: [{ $eq: ["$bookingStatus", "cancelled"] }, 1, 0] },
  },
};

const parseDayCount = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 0;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

const inclusiveDayCount = (startDate, endDate) => {
  const start = parseDayCount(startDate);
  const end = parseDayCount(endDate);
  if (!start || !end || end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
};

const serializeRecentBooking = (row) => {
  const status = BOOKING_STATUSES.includes(row?.status) ? row.status : "confirmed";
  const paymentStatus = ["paid", "unpaid", "refunded"].includes(row?.paymentStatus)
    ? row.paymentStatus
    : "paid";

  return {
    id: String(row?._id ?? ""),
    equipmentId: String(row?.equipmentId ?? ""),
    equipmentName: row?.equipmentName || "Equipment unavailable",
    equipmentImage: row?.equipmentImage ?? undefined,
    status,
    paymentStatus,
    startDate: row?.startDate ?? undefined,
    endDate: row?.endDate ?? undefined,
    days: inclusiveDayCount(row?.startDate, row?.endDate),
    quantity: count(row?.quantity) || 1,
    totalAmount: count(row?.totalAmount),
    currency: row?.currency || "BDT",
    createdAt: row?.createdAt ?? undefined,
    canReview:
      (status === "confirmed" || status === "completed") &&
      paymentStatus === "paid",
  };
};

export const parseBookingPeriod = (value) => {
  if (typeof value !== "string") return null;
  const match = /^(\d+)months$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  const months = Number(match[1]);
  return BOOKING_PERIODS.includes(months) ? months : null;
};

export const parseRecentBookingLimit = (value) => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RECENT_LIMIT;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RECENT_LIMIT;
  return Math.min(MAX_RECENT_LIMIT, Math.max(1, parsed));
};

/** Build UTC month buckets without relying on static sample periods. */
const monthWindow = (months) => {
  const now = new Date();
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - index), 1),
    );
    const year = date.getUTCFullYear();
    const monthNumber = date.getUTCMonth() + 1;
    const paddedMonth = String(monthNumber).padStart(2, "0");

    return {
      key: `${year}-${paddedMonth}`,
      year,
      monthNumber,
      month: MONTH_LABELS[monthNumber - 1],
      label: `${MONTH_LABELS[monthNumber - 1]} ${String(year).slice(2)}`,
    };
  });
};

const getFavoriteCount = async (database, customerId) => {
  const [result] = await database
    .collection(FAVORITE_COLLECTION)
    .aggregate([
      { $match: { userId: customerId } },
      {
        $lookup: {
          from: EQUIPMENT_COLLECTION,
          let: { equipmentId: toText("equipmentId") },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: [toText("_id"), "$$equipmentId"] },
                    {
                      $in: [
                        lowerText("status", "approved"),
                        ["approved", ""],
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "equipment",
        },
      },
      { $match: { "equipment.0": { $exists: true } } },
      { $count: "count" },
    ])
    .toArray();

  return count(result?.count);
};

/**
 * GearNest has no review collection yet. Counts come from the real `reviews`
 * collection when present, scoped to the verified customer, and stay at zero
 * until a review is actually published. No review data is fabricated.
 */
const getPublishedReviewCount = async (database, authUser) => {
  const customerId = String(authUser?.id ?? "");
  const email = String(authUser?.email ?? "").trim().toLowerCase();

  const [result] = await database
    .collection(REVIEW_COLLECTION)
    .aggregate([
      {
        $match: {
          $expr: {
            $and: [
              {
                $or: [
                  { $eq: [toText("userId"), customerId] },
                  { $eq: [toText("customerId"), customerId] },
                  ...(email
                    ? [
                        { $eq: [lowerText("userEmail"), email] },
                        { $eq: [lowerText("email"), email] },
                      ]
                    : []),
                ],
              },
              { $ne: [{ $ifNull: ["$published", true] }, false] },
              {
                $not: {
                  $in: [
                    lowerText("status", "published"),
                    HIDDEN_REVIEW_STATUSES,
                  ],
                },
              },
            ],
          },
        },
      },
      { $count: "count" },
    ])
    .toArray();

  return count(result?.count);
};

/**
 * GET /customer/dashboard/overview data. Every value is derived from the
 * authenticated customer's own purchases, favorites, and reviews.
 */
export const getCustomerDashboardOverview = async (database, authUser) => {
  const customerId = String(authUser?.id ?? "");
  const purchases = database.collection(PURCHASE_COLLECTION);

  const [purchaseResult, favoriteItems, reviewsPublished] = await Promise.all([
    purchases
      .aggregate([
        customerMatch(customerId),
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
            bookings: [{ $group: { _id: null, ...statusAccumulator } }],
            payments: [
              { $match: { isSuccessfulPayment: true } },
              {
                $group: {
                  _id: "$paymentKey",
                  amountMinor: { $max: { $ifNull: ["$amountTotal", 0] } },
                  currency: { $first: currencyExpression },
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
                  amountMinor: { $max: { $ifNull: ["$amountTotal", 0] } },
                },
              },
              {
                $group: {
                  _id: "$currency",
                  transactions: { $sum: 1 },
                  amountMinor: { $sum: "$amountMinor" },
                },
              },
              { $sort: { transactions: -1, _id: 1 } },
            ],
          },
        },
      ])
      .toArray(),
    getFavoriteCount(database, customerId),
    getPublishedReviewCount(database, authUser),
  ]);

  const bookingSummary = purchaseResult?.[0]?.bookings?.[0] ?? {};
  const paymentSummary = purchaseResult?.[0]?.payments?.[0] ?? {};
  const currencyRows = purchaseResult?.[0]?.currency ?? [];
  const currency = currencyRows[0]?._id || "BDT";

  return {
    customerName: String(authUser?.name ?? "").trim() || "Customer",
    totalBookings: count(bookingSummary.totalBookings),
    pendingBookings: count(bookingSummary.pendingBookings),
    confirmedBookings: count(bookingSummary.confirmedBookings),
    completedBookings: count(bookingSummary.completedBookings),
    cancelledBookings: count(bookingSummary.cancelledBookings),
    favoriteItems,
    /** Gross successful payment volume; not a payout or commission. */
    totalSpent: count(paymentSummary.revenueMinorUnits) / 100,
    paidTransactions: count(paymentSummary.paidTransactions),
    reviewsPublished,
    currency,
    currencyBreakdown: currencyRows.map((row) => ({
      currency: row._id || "BDT",
      transactions: count(row.transactions),
      totalSpent: count(row.amountMinor) / 100,
    })),
    generatedAt: new Date().toISOString(),
    definitions: {
      totalSpent:
        "Gross paid rental volume from successful purchases, deduplicated by Stripe session. Refunded, unpaid, cancelled, deleted, and invalid records are excluded.",
      favoriteItems:
        "Saved equipment listings that are still visible in the public catalog.",
      reviewsPublished:
        "Published reviews submitted by your account. Zero when no review has been submitted.",
    },
  };
};

/** GET /customer/dashboard/booking-status data. */
export const getCustomerBookingStatus = async (database, authUser) => {
  const customerId = String(authUser?.id ?? "");

  const [result] = await database
    .collection(PURCHASE_COLLECTION)
    .aggregate([
      customerMatch(customerId),
      { $addFields: { bookingStatus: bookingStatusExpression } },
      { $group: { _id: null, ...statusAccumulator } },
    ])
    .toArray();

  const summary = result ?? {};

  return {
    totalBookings: count(summary.totalBookings),
    statusCounts: {
      all: count(summary.totalBookings),
      pending: count(summary.pendingBookings),
      confirmed: count(summary.confirmedBookings),
      completed: count(summary.completedBookings),
      cancelled: count(summary.cancelledBookings),
    },
    bookingStatusesIncluded: BOOKING_STATUSES,
    generatedAt: new Date().toISOString(),
  };
};

/**
 * GET /customer/dashboard/booking-analytics data. Only real booking months are
 * counted and months without bookings remain zero.
 */
export const getCustomerBookingAnalytics = async (
  database,
  authUser,
  months,
) => {
  const customerId = String(authUser?.id ?? "");
  const window = monthWindow(months);
  const start = new Date(Date.UTC(window[0].year, window[0].monthNumber - 1, 1));
  const last = window[window.length - 1];
  const end = new Date(Date.UTC(last.year, last.monthNumber, 1));

  const rows = await database
    .collection(PURCHASE_COLLECTION)
    .aggregate([
      customerMatch(customerId),
      {
        $addFields: {
          createdAtDate: createdAtDateExpression,
          bookingStatus: bookingStatusExpression,
        },
      },
      { $match: { createdAtDate: { $ne: null } } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAtDate" },
            month: { $month: "$createdAtDate" },
            status: "$bookingStatus",
          },
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          "_id.year": { $gte: start.getUTCFullYear(), $lte: end.getUTCFullYear() },
        },
      },
    ])
    .toArray();

  const countsByMonth = new Map();
  for (const row of rows) {
    const month = Number(row?._id?.month);
    const year = Number(row?._id?.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    if (!Number.isInteger(year)) continue;

    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (!countsByMonth.has(key)) {
      countsByMonth.set(key, {
        totalBookings: 0,
        pendingBookings: 0,
        confirmedBookings: 0,
        completedBookings: 0,
        cancelledBookings: 0,
      });
    }

    const entry = countsByMonth.get(key);
    const value = count(row.count);
    entry.totalBookings += value;

    if (row._id.status === "pending") entry.pendingBookings += value;
    else if (row._id.status === "completed") entry.completedBookings += value;
    else if (row._id.status === "cancelled") entry.cancelledBookings += value;
    else entry.confirmedBookings += value;
  }

  const monthlyBookings = window.map((bucket) => ({
    ...bucket,
    ...(countsByMonth.get(bucket.key) ?? {
      totalBookings: 0,
      pendingBookings: 0,
      confirmedBookings: 0,
      completedBookings: 0,
      cancelledBookings: 0,
    }),
  }));

  return {
    period: `${months}months`,
    months,
    monthlyBookings,
    totalBookings: monthlyBookings.reduce(
      (sum, item) => sum + item.totalBookings,
      0,
    ),
    availablePeriods: BOOKING_PERIODS.map((value) => `${value}months`),
    bookingStatusesIncluded: BOOKING_STATUSES,
    timezone: "UTC",
    generatedAt: new Date().toISOString(),
  };
};

/** GET /customer/dashboard/recent-bookings data. */
export const getCustomerRecentBookings = async (
  database,
  authUser,
  limit = DEFAULT_RECENT_LIMIT,
) => {
  const customerId = String(authUser?.id ?? "");
  const safeLimit = parseRecentBookingLimit(limit);

  const rows = await database
    .collection(PURCHASE_COLLECTION)
    .aggregate([
      customerMatch(customerId),
      {
        $addFields: {
          createdAtDate: createdAtDateExpression,
          bookingStatus: bookingStatusExpression,
          paymentStatus: paymentStatusExpression,
        },
      },
      { $sort: { createdAtDate: -1, _id: -1 } },
      { $limit: safeLimit },
      equipmentLookup,
      { $addFields: { equipment: { $arrayElemAt: ["$equipment", 0] } } },
      {
        $project: {
          _id: { $toString: "$_id" },
          equipmentId: { $toString: "$equipmentId" },
          equipmentName: {
            $ifNull: ["$equipment.name", "Equipment unavailable"],
          },
          equipmentImage: equipmentImageExpression,
          status: "$bookingStatus",
          paymentStatus: "$paymentStatus",
          startDate: { $ifNull: ["$startDate", null] },
          endDate: { $ifNull: ["$endDate", null] },
          quantity: {
            $cond: [
              { $gt: [{ $ifNull: ["$quantity", 0] }, 0] },
              "$quantity",
              1,
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
          createdAt: isoDateExpression,
        },
      },
    ])
    .toArray();

  return {
    bookings: rows.map(serializeRecentBooking),
    totalReturned: rows.length,
    generatedAt: new Date().toISOString(),
  };
};
