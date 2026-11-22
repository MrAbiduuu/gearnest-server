/**
 * MongoDB aggregations and moderation helpers for the admin bookings record.
 *
 * A booking is a `purchases` document created after Stripe confirms payment.
 * Renter and equipment details live in other collections, so the list endpoint
 * resolves those relationships with `$lookup` instead of per-row requests.
 */
import { ObjectId } from "mongodb";

const USER_COLLECTION = "user";
const EQUIPMENT_COLLECTION = "equipments";
const PURCHASE_COLLECTION = "purchases";

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
];
export const BOOKING_PAYMENT_STATUSES = ["paid", "unpaid", "refunded"];

const ALLOWED_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const isBookingStatus = (value) =>
  BOOKING_STATUSES.includes(String(value ?? "").toLowerCase());

export const isBookingPaymentStatus = (value) =>
  BOOKING_PAYMENT_STATUSES.includes(String(value ?? "").toLowerCase());

export const getAllowedBookingTransitions = (status) => {
  const normalized = String(status ?? "").toLowerCase();
  return ALLOWED_TRANSITIONS[normalized] ?? [];
};

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const textOf = (path, fallback = "") => ({
  $convert: {
    input: `$${path}`,
    to: "string",
    onError: fallback,
    onNull: fallback,
  },
});

const lowerTextOf = (path, fallback = "") => ({
  $toLower: textOf(path, fallback),
});

const createdAtDateExpression = {
  $convert: {
    input: "$createdAt",
    to: "date",
    onError: null,
    onNull: null,
  },
};

const statusExpression = {
  $switch: {
    branches: [
      {
        case: { $eq: [lowerTextOf("status"), "pending"] },
        then: "pending",
      },
      {
        case: { $in: [lowerTextOf("status"), ["completed", "complete"]] },
        then: "completed",
      },
      {
        case: { $in: [lowerTextOf("status"), ["cancelled", "canceled"]] },
        then: "cancelled",
      },
    ],
    default: "confirmed",
  },
};

const paymentStatusExpression = {
  $switch: {
    branches: [
      {
        case: { $eq: [lowerTextOf("paymentStatus", "paid"), "unpaid"] },
        then: "unpaid",
      },
      {
        case: {
          $or: [
            { $eq: [lowerTextOf("paymentStatus", "paid"), "refunded"] },
            { $ne: [{ $ifNull: ["$refundedAt", null] }, null] },
          ],
        },
        then: "refunded",
      },
    ],
    default: "paid",
  },
};

/** Shared stages that attach renter/equipment data and normalized fields. */
const enrichmentStages = [
  {
    $addFields: {
      createdAtDate: createdAtDateExpression,
      bookingStatus: statusExpression,
      paymentStatus: paymentStatusExpression,
      totalAmountMinor: {
        $cond: [
          { $isNumber: "$amountTotal" },
          { $ifNull: ["$amountTotal", 0] },
          0,
        ],
      },
    },
  },
  {
    $lookup: {
      from: USER_COLLECTION,
      let: { userId: textOf("userId") },
      pipeline: [
        {
          $match: {
            $expr: { $eq: [textOf("_id"), "$$userId"] },
          },
        },
        { $project: { name: 1, email: 1, phone: 1, _id: 0 } },
        { $limit: 1 },
      ],
      as: "renter",
    },
  },
  {
    $lookup: {
      from: EQUIPMENT_COLLECTION,
      let: { equipmentId: textOf("equipmentId") },
      pipeline: [
        {
          $match: {
            $expr: { $eq: [textOf("_id"), "$$equipmentId"] },
          },
        },
        {
          $project: {
            name: 1,
            image: 1,
            images: 1,
            category: 1,
            owner: 1,
            _id: 0,
          },
        },
        { $limit: 1 },
      ],
      as: "equipmentDoc",
    },
  },
  {
    $addFields: {
      renterDoc: { $arrayElemAt: ["$renter", 0] },
      equipment: { $arrayElemAt: ["$equipmentDoc", 0] },
    },
  },
  {
    $addFields: {
      searchText: {
        $toLower: {
          $concat: [
            textOf("_id"),
            " ",
            textOf("equipmentId"),
            " ",
            textOf("userId"),
            " ",
            textOf("equipment.name"),
            " ",
            textOf("renterDoc.name"),
            " ",
            textOf("renterDoc.email"),
            " ",
            textOf("renterDoc.phone"),
            " ",
            textOf("equipment.owner.id"),
            " ",
            textOf("equipment.owner._id"),
            " ",
            textOf("equipment.owner.name"),
            " ",
            textOf("equipment.owner.email"),
            " ",
            textOf("stripeSessionId"),
          ],
        },
      },
    },
  },
];

const bookingProjection = {
  _id: textOf("_id"),
  equipmentId: textOf("equipmentId"),
  equipmentName: {
    $ifNull: [textOf("equipment.name"), "Equipment unavailable"],
  },
  equipmentImage: {
    $ifNull: [
      { $arrayElemAt: [{ $ifNull: ["$equipment.images", []] }, 0] },
      { $ifNull: [textOf("equipment.image"), null] },
      null,
    ],
  },
  equipmentCategory: { $ifNull: [textOf("equipment.category"), ""] },
  renterName: {
    $ifNull: [textOf("renterDoc.name"), "Renter unavailable"],
  },
  renterEmail: {
    $ifNull: [textOf("renterDoc.email"), "Email unavailable"],
  },
  renterPhone: { $ifNull: [textOf("renterDoc.phone"), ""] },
  ownerName: { $ifNull: [textOf("equipment.owner.name"), ""] },
  ownerEmail: { $ifNull: [textOf("equipment.owner.email"), ""] },
  status: "$bookingStatus",
  paymentStatus: "$paymentStatus",
  totalAmount: { $divide: ["$totalAmountMinor", 100] },
  currency: {
    $toUpper: {
      $convert: {
        input: "$currency",
        to: "string",
        onError: "BDT",
        onNull: "BDT",
      },
    },
  },
  startDate: { $ifNull: [textOf("startDate"), ""] },
  endDate: { $ifNull: [textOf("endDate"), ""] },
  quantity: { $ifNull: ["$quantity", 1] },
  deliveryAddress: { $ifNull: [textOf("deliveryAddress"), ""] },
  createdAt: {
    $dateToString: {
      date: "$createdAtDate",
      format: "%Y-%m-%dT%H:%M:%S.%LZ",
      onNull: null,
    },
  },
};

const inclusiveDayCount = (start, end) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return 0;
  }

  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const difference =
    Date.UTC(endYear, endMonth - 1, endDay) -
    Date.UTC(startYear, startMonth - 1, startDay);

  return Math.max(0, Math.floor(difference / 86_400_000) + 1);
};

const countValue = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const textValue = (value) =>
  value === undefined || value === null ? "" : String(value);

const serializeBooking = (row) => {
  const status = isBookingStatus(row.status) ? row.status.toLowerCase() : "confirmed";
  const paymentStatus = isBookingPaymentStatus(row.paymentStatus)
    ? row.paymentStatus.toLowerCase()
    : "paid";
  const quantity =
    Number.isFinite(Number(row.quantity)) && Number(row.quantity) > 0
      ? Math.floor(Number(row.quantity))
      : 1;

  return {
    id: textValue(row._id),
    equipmentId: textValue(row.equipmentId),
    equipmentName: row.equipmentName || "Equipment unavailable",
    equipmentImage: row.equipmentImage || undefined,
    equipmentCategory: row.equipmentCategory || undefined,
    renterName: row.renterName || "Renter unavailable",
    renterEmail: row.renterEmail || "Email unavailable",
    renterPhone: row.renterPhone || undefined,
    ownerName: row.ownerName || undefined,
    ownerEmail: row.ownerEmail || undefined,
    status,
    paymentStatus,
    allowedStatuses: getAllowedBookingTransitions(status),
    startDate: row.startDate || undefined,
    endDate: row.endDate || undefined,
    days: inclusiveDayCount(row.startDate, row.endDate),
    quantity,
    deliveryAddress: row.deliveryAddress || undefined,
    totalAmount: countValue(row.totalAmount),
    currency: row.currency || "BDT",
    createdAt: row.createdAt || undefined,
  };
};

export const parseBookingsQuery = (query) => {
  const requestedStatus =
    typeof query.status === "string" ? query.status.trim().toLowerCase() : "all";
  const status = requestedStatus === "all" || isBookingStatus(requestedStatus)
    ? requestedStatus
    : null;

  const search = typeof query.search === "string" ? query.search.trim() : "";
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 10));
  const sort = query.sort === "oldest" ? "oldest" : "newest";

  if (status === null || search.length > 120) return null;

  return { status, search, page, limit, sort };
};

export const getAdminBookings = async (database, options) => {
  const purchases = database.collection(PURCHASE_COLLECTION);
  const { status, search, page, limit, sort } = options;

  const searchStages = search
    ? [
        {
          $match: {
            searchText: { $regex: escapeRegex(search), $options: "i" },
          },
        },
      ]
    : [];
  const statusStages =
    status === "all" ? [] : [{ $match: { bookingStatus: status } }];
  const sortStage =
    sort === "oldest"
      ? { createdAtDate: 1, _id: 1 }
      : { createdAtDate: -1, _id: -1 };

  const [result] = await purchases
    .aggregate([
      ...enrichmentStages,
      {
        $facet: {
          global: [{ $count: "count" }],
          statusCounts: [
            ...searchStages,
            { $group: { _id: "$bookingStatus", count: { $sum: 1 } } },
          ],
          total: [...searchStages, ...statusStages, { $count: "count" }],
          items: [
            ...searchStages,
            ...statusStages,
            { $sort: sortStage },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            { $project: bookingProjection },
          ],
        },
      },
    ])
    .toArray();

  const statusCounts = {
    pending: 0,
    confirmed: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const row of result?.statusCounts ?? []) {
    if (isBookingStatus(row._id)) {
      statusCounts[row._id] = countValue(row.count);
    }
  }

  const matchedTotal = countValue(result?.total?.[0]?.count);
  const totalBookings = countValue(result?.global?.[0]?.count);
  const bookings = (result?.items ?? []).map(serializeBooking);

  return {
    bookings,
    totalBookings,
    total: matchedTotal,
    statusCounts: {
      all:
        statusCounts.pending +
        statusCounts.confirmed +
        statusCounts.completed +
        statusCounts.cancelled,
      ...statusCounts,
    },
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(matchedTotal / limit)),
    limit,
    hasMore: page * limit < matchedTotal,
  };
};

const getEnrichedBooking = async (database, objectId) => {
  const [row] = await database
    .collection(PURCHASE_COLLECTION)
    .aggregate([
      { $match: { _id: objectId } },
      ...enrichmentStages,
      { $limit: 1 },
      { $project: bookingProjection },
    ])
    .toArray();

  return row ? serializeBooking(row) : null;
};

export const getAdminBookingById = async (database, id) => {
  if (!ObjectId.isValid(id)) return null;
  return getEnrichedBooking(database, new ObjectId(id));
};

/**
 * Returns { notFound } / { invalidTransition } / { booking, unchanged }.
 * Transition rules are defined here so the UI cannot drift from the backend.
 */
export const updateAdminBookingStatus = async (database, id, requestedStatus) => {
  if (!ObjectId.isValid(id) || !isBookingStatus(requestedStatus)) {
    return { invalidRequest: true };
  }

  const objectId = new ObjectId(id);
  const status = requestedStatus.toLowerCase();
  const existing = await database
    .collection(PURCHASE_COLLECTION)
    .findOne({ _id: objectId }, { projection: { status: 1 } });

  if (!existing) return { notFound: true };

  const current = String(existing.status ?? "").toLowerCase();
  const normalizedCurrent =
    current === "canceled" ? "cancelled" : isBookingStatus(current) ? current : "confirmed";

  if (normalizedCurrent === status) {
    return { booking: await getEnrichedBooking(database, objectId), unchanged: true };
  }

  if (!getAllowedBookingTransitions(normalizedCurrent).includes(status)) {
    return { invalidTransition: true, current: normalizedCurrent };
  }

  await database
    .collection(PURCHASE_COLLECTION)
    .updateOne({ _id: objectId }, { $set: { status } });

  return { booking: await getEnrichedBooking(database, objectId) };
};
