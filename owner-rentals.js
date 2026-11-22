/**
 * Owner-scoped rental requests.
 *
 * A rental is a `purchases` document created after Stripe confirms payment.
 * Ownership is resolved from the verified `req.authUser.email`; the browser
 * never supplies an owner ID. Purchases are joined to equipment owned by that
 * email before they are counted, searched, or returned.
 *
 * Booking and payment status remain independent. Allowed booking transitions
 * are reused from the existing admin booking workflow so owner and admin
 * moderation cannot drift apart.
 */
import { ObjectId } from "mongodb";
import {
  BOOKING_STATUSES,
  getAllowedBookingTransitions,
  isBookingStatus,
} from "./bookings.js";
import {
  equipmentStatusExpression,
  isEquipmentStatus,
} from "./equipment-moderation.js";

const USER_COLLECTION = "user";
const EQUIPMENT_COLLECTION = "equipments";
const PURCHASE_COLLECTION = "purchases";

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

const countValue = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const textValue = (value) =>
  value === undefined || value === null ? "" : String(value);

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
      { case: { $eq: [lowerTextOf("status"), "pending"] }, then: "pending" },
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
      { case: { $eq: [lowerTextOf("paymentStatus", "paid"), "unpaid"] }, then: "unpaid" },
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

const ownerEquipmentLookup = (email) => ({
  $lookup: {
    from: EQUIPMENT_COLLECTION,
    let: { equipmentId: textOf("equipmentId") },
    pipeline: [
      {
        $match: {
          $expr: {
            $and: [
              { $eq: [textOf("_id"), "$$equipmentId"] },
              { $eq: [lowerTextOf("owner.email"), email] },
            ],
          },
        },
      },
      {
        $project: {
          name: 1,
          image: 1,
          images: 1,
          category: 1,
          availableStock: 1,
          _id: 1,
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
};

/** Stages that scope a purchase to the owner, then attach related records. */
const ownerEnrichmentStages = (email) => [
  ownerEquipmentLookup(email),
  { $match: { "ownerEquipment.0": { $exists: true } } },
  {
    $addFields: {
      equipment: { $arrayElemAt: ["$ownerEquipment", 0] },
      createdAtDate: createdAtDateExpression,
      bookingStatus: bookingStatusExpression,
      paymentStatus: paymentStatusExpression,
      amountMinor: {
        $cond: [
          { $isNumber: "$amountTotal" },
          { $ifNull: ["$amountTotal", 0] },
          0,
        ],
      },
    },
  },
  renterLookup,
  { $addFields: { renterDoc: { $arrayElemAt: ["$renter", 0] } } },
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
            textOf("equipment.category"),
            " ",
            textOf("renterDoc.name"),
            " ",
            textOf("renterDoc.email"),
            " ",
            textOf("renterDoc.phone"),
          ],
        },
      },
    },
  },
];

const bookingProjection = {
  _id: textOf("_id"),
  equipmentId: textOf("equipmentId"),
  equipment: {
    id: textOf("equipment._id"),
    name: { $ifNull: [textOf("equipment.name"), "Equipment unavailable"] },
    category: { $ifNull: [textOf("equipment.category"), ""] },
    image: {
      $ifNull: [
        { $arrayElemAt: [{ $ifNull: ["$equipment.images", []] }, 0] },
        { $ifNull: [textOf("equipment.image"), null] },
        null,
      ],
    },
  },
  renter: {
    name: { $ifNull: [textOf("renterDoc.name"), "Renter unavailable"] },
    email: { $ifNull: [textOf("renterDoc.email"), "Email unavailable"] },
    phone: { $ifNull: [textOf("renterDoc.phone"), ""] },
  },
  payment: {
    status: "$paymentStatus",
    amount: { $divide: ["$amountMinor", 100] },
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
  },
  status: "$bookingStatus",
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

const normalizeStatus = (value) =>
  isBookingStatus(value) ? String(value).toLowerCase() : "confirmed";

const serializeOwnerRental = (row) => {
  const status = normalizeStatus(row?.status);
  const paymentStatus = normalizePaymentStatus(row?.payment?.status);
  const quantity =
    Number.isFinite(Number(row?.quantity)) && Number(row.quantity) > 0
      ? Math.floor(Number(row.quantity))
      : 1;

  return {
    id: textValue(row?._id),
    equipmentId: textValue(row?.equipmentId),
    equipment: {
      id: textValue(row?.equipment?.id),
      name: row?.equipment?.name || "Equipment unavailable",
      category: row?.equipment?.category || undefined,
      image: row?.equipment?.image || undefined,
    },
    renter: {
      name: row?.renter?.name || "Renter unavailable",
      email: row?.renter?.email || "Email unavailable",
      phone: row?.renter?.phone || undefined,
    },
    payment: {
      status: paymentStatus,
      amount: countValue(row?.payment?.amount),
      currency: row?.payment?.currency || "BDT",
    },
    status,
    allowedStatuses: getAllowedBookingTransitions(status),
    startDate: row?.startDate || undefined,
    endDate: row?.endDate || undefined,
    days: inclusiveDayCount(row?.startDate, row?.endDate),
    quantity,
    deliveryAddress: row?.deliveryAddress || undefined,
    createdAt: row?.createdAt || undefined,
  };
};

const normalizePaymentStatus = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "unpaid" || normalized === "refunded") return normalized;
  return "paid";
};

const buildStats = (rows, totalBookings) => {
  const counts = { pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
  for (const row of rows ?? []) {
    if (BOOKING_STATUSES.includes(row?._id)) {
      counts[row._id] = countValue(row.count);
    }
  }

  return {
    totalBookings: countValue(totalBookings),
    statusCounts: {
      all:
        counts.pending +
        counts.confirmed +
        counts.completed +
        counts.cancelled,
      ...counts,
    },
  };
};

const searchStagesFor = (search) =>
  search
    ? [{ $match: { searchText: { $regex: escapeRegex(search), $options: "i" } } }]
    : [];

const statusStagesFor = (status) =>
  status && status !== "all" ? [{ $match: { bookingStatus: status } }] : [];

const sortStageFor = (sort) =>
  sort === "oldest"
    ? { createdAtDate: 1, _id: 1 }
    : { createdAtDate: -1, _id: -1 };

const equipmentSearchStages = (search) =>
  search
    ? [
        {
          $match: {
            $expr: {
              $or: ["name", "category", "brand", "model"].map((path) => ({
                $regexMatch: {
                  input: textOf(path),
                  regex: escapeRegex(search),
                  options: "i",
                },
              })),
            },
          },
        },
      ]
    : [];

const serializeOwnerRentalEquipment = (row) => {
  const status = isEquipmentStatus(row?.status)
    ? String(row.status).toLowerCase()
    : "approved";
  const confirmedRequests = countValue(row?.confirmedRequests);

  return {
    id: textValue(row?._id),
    name: row?.name || "Equipment unavailable",
    category: row?.category || undefined,
    image: row?.image || undefined,
    rentalRate: countValue(row?.rentalRate),
    rentalPeriod: row?.rentalPeriod || undefined,
    availableStock: countValue(row?.availableStock),
    status,
    requestCount: countValue(row?.requestCount),
    pendingRequests: countValue(row?.pendingRequests),
    confirmedRequests,
    completedRequests: countValue(row?.completedRequests),
    cancelledRequests: countValue(row?.cancelledRequests),
    isOnRent: confirmedRequests > 0,
    createdAt: row?.createdAt || undefined,
  };
};

/**
 * Owner equipment with request counts. This is returned alongside bookings so
 * a published listing with no bookings is still visible in My Rentals.
 * Ownership is resolved from the verified session email, never from a query.
 */
const getOwnerRentalEquipment = async (database, authUser, search) => {
  const rows = await database
    .collection(EQUIPMENT_COLLECTION)
    .aggregate([
      {
        $match: {
          $expr: {
            $eq: [lowerTextOf("owner.email"), ownerEmail(authUser)],
          },
        },
      },
      ...equipmentSearchStages(search),
      {
        $lookup: {
          from: PURCHASE_COLLECTION,
          let: { equipmentId: textOf("_id") },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [textOf("equipmentId"), "$$equipmentId"],
                },
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                pending: {
                  $sum: {
                    $cond: [{ $eq: [bookingStatusExpression, "pending"] }, 1, 0],
                  },
                },
                confirmed: {
                  $sum: {
                    $cond: [
                      { $eq: [bookingStatusExpression, "confirmed"] },
                      1,
                      0,
                    ],
                  },
                },
                completed: {
                  $sum: {
                    $cond: [
                      { $eq: [bookingStatusExpression, "completed"] },
                      1,
                      0,
                    ],
                  },
                },
                cancelled: {
                  $sum: {
                    $cond: [{ $eq: [bookingStatusExpression, "cancelled"] }, 1, 0],
                  },
                },
              },
            },
          ],
          as: "rentalSummary",
        },
      },
      {
        $addFields: {
          equipmentStatus: equipmentStatusExpression,
          rentalSummary: {
            $ifNull: [
              { $arrayElemAt: ["$rentalSummary", 0] },
              {
                total: 0,
                pending: 0,
                confirmed: 0,
                completed: 0,
                cancelled: 0,
              },
            ],
          },
        },
      },
      {
        $project: {
          _id: textOf("_id"),
          name: { $ifNull: [textOf("name"), "Equipment unavailable"] },
          category: { $ifNull: [textOf("category"), ""] },
          image: {
            $ifNull: [
              { $arrayElemAt: [{ $ifNull: ["$images", []] }, 0] },
              { $ifNull: [textOf("image"), null] },
              null,
            ],
          },
          rentalRate: { $ifNull: ["$rentalRate", 0] },
          rentalPeriod: { $ifNull: [textOf("rentalPeriod"), ""] },
          availableStock: { $ifNull: ["$availableStock", 0] },
          status: "$equipmentStatus",
          requestCount: "$rentalSummary.total",
          pendingRequests: "$rentalSummary.pending",
          confirmedRequests: "$rentalSummary.confirmed",
          completedRequests: "$rentalSummary.completed",
          cancelledRequests: "$rentalSummary.cancelled",
          isOnRent: { $gt: ["$rentalSummary.confirmed", 0] },
          createdAt: {
            $dateToString: {
              date: createdAtDateExpression,
              format: "%Y-%m-%dT%H:%M:%S.%LZ",
              onNull: null,
            },
          },
        },
      },
      { $sort: { isOnRent: -1, createdAt: -1, _id: -1 } },
    ])
    .toArray();

  return rows.map(serializeOwnerRentalEquipment);
};

/**
 * GET /owner/rentals data. `parseBookingsQuery` is reused so owner and admin
 * search parameters validate identically.
 */
export const getOwnerRentals = async (database, authUser, options) => {
  const email = ownerEmail(authUser);
  const { status, search, page, limit, sort } = options;
  const searchStages = searchStagesFor(search);
  const statusStages = statusStagesFor(status);

  const [result, equipment] = await Promise.all([
    database
      .collection(PURCHASE_COLLECTION)
      .aggregate([
        ...ownerEnrichmentStages(email),
        {
          $facet: {
            global: [{ $count: "count" }],
            statusCounts: [
              ...searchStages,
              { $group: { _id: "$bookingStatus", count: { $sum: 1 } } },
            ],
            matched: [
              ...searchStages,
              ...statusStages,
              { $count: "count" },
            ],
            items: [
              ...searchStages,
              ...statusStages,
              { $sort: sortStageFor(sort) },
              { $skip: (page - 1) * limit },
              { $limit: limit },
              { $project: bookingProjection },
            ],
          },
        },
      ])
      .toArray(),
    getOwnerRentalEquipment(database, authUser, search),
  ]);

  const total = countValue(result?.[0]?.matched?.[0]?.count);
  const stats = buildStats(
    result?.[0]?.statusCounts,
    result?.[0]?.global?.[0]?.count ?? 0,
  );

  return {
    bookings: (result?.[0]?.items ?? []).map(serializeOwnerRental),
    equipment,
    stats,
    total,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    limit,
    hasMore: page * limit < total,
  };
};

/** GET /owner/rentals/stats data: owner-global counts, unaffected by search. */
export const getOwnerRentalStats = async (database, authUser) => {
  const email = ownerEmail(authUser);
  const [result] = await database
    .collection(PURCHASE_COLLECTION)
    .aggregate([
      ...ownerEnrichmentStages(email),
      {
        $facet: {
          global: [{ $count: "count" }],
          statusCounts: [
            { $group: { _id: "$bookingStatus", count: { $sum: 1 } } },
          ],
        },
      },
    ])
    .toArray();

  return buildStats(result?.statusCounts, result?.global?.[0]?.count ?? 0);
};

const getOwnerRentalById = async (database, authUser, id) => {
  if (!ObjectId.isValid(id)) return null;

  const [row] = await database
    .collection(PURCHASE_COLLECTION)
    .aggregate([
      { $match: { _id: new ObjectId(id) } },
      ...ownerEnrichmentStages(ownerEmail(authUser)),
      { $limit: 1 },
      { $project: bookingProjection },
    ])
    .toArray();

  return row ? serializeOwnerRental(row) : null;
};

const positiveQuantity = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.floor(Number(value))
    : 1;

const nonNegativeInteger = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.floor(Number(value))
    : 0;

/**
 * PATCH /owner/rentals/:id/status
 *
 * Verifies the purchase belongs to the authenticated owner's equipment, uses
 * the shared transition rules, and rechecks stock before approval. Stock is
 * already reserved when checkout records the purchase, so approval validates
 * availability without deducting it a second time.
 */
export const updateOwnerRentalStatus = async (
  database,
  authUser,
  id,
  requestedStatus,
) => {
  if (!ObjectId.isValid(id) || !isBookingStatus(requestedStatus)) {
    return { invalidRequest: true };
  }

  const status = String(requestedStatus).toLowerCase();
  const objectId = new ObjectId(id);
  const purchases = database.collection(PURCHASE_COLLECTION);

  const purchase = await purchases.findOne(
    { _id: objectId },
    {
      projection: {
        equipmentId: 1,
        status: 1,
        quantity: 1,
        stockReduced: 1,
        restoredQuantity: 1,
        restoredAt: 1,
      },
    },
  );

  if (!purchase) return { notFound: true };

  const equipmentId = purchase.equipmentId;
  if (!ObjectId.isValid(equipmentId)) return { notFound: true };

  const equipment = await database
    .collection(EQUIPMENT_COLLECTION)
    .findOne(
      {
        _id: new ObjectId(equipmentId),
        $expr: { $eq: [lowerTextOf("owner.email"), ownerEmail(authUser)] },
      },
      { projection: { availableStock: 1 } },
    );

  if (!equipment) return { notFound: true };

  const rawStatus = String(purchase.status ?? "").trim().toLowerCase();
  const current =
    rawStatus === "canceled"
      ? "cancelled"
      : isBookingStatus(rawStatus)
        ? rawStatus
        : "confirmed";

  if (current === status) {
    return {
      booking: await getOwnerRentalById(database, authUser, id),
      unchanged: true,
    };
  }

  if (!getAllowedBookingTransitions(current).includes(status)) {
    return { invalidTransition: true, current };
  }

  if (status === "confirmed") {
    const requestedQuantity = positiveQuantity(purchase.quantity);
    const availableStock = nonNegativeInteger(equipment.availableStock);
    const stillReserved =
      purchase.stockReduced === true && !purchase.restoredAt;
    const reservedQuantity = stillReserved
      ? nonNegativeInteger(purchase.restoredQuantity)
      : 0;
    const effectiveAvailable = availableStock + reservedQuantity;

    if (effectiveAvailable < requestedQuantity) {
      return {
        conflict: true,
        detail: `Only ${effectiveAvailable} ${
          effectiveAvailable === 1 ? "unit is" : "units are"
        } available for this request.`,
      };
    }
  }

  // Match the exact current value so two simultaneous decisions cannot both win.
  const currentCondition = rawStatus
    ? { _id: objectId, status: String(purchase.status) }
    : {
        _id: objectId,
        $or: [
          { status: { $exists: false } },
          { status: null },
          { status: "" },
        ],
      };

  const updateResult = await purchases.findOneAndUpdate(
    currentCondition,
    { $set: { status } },
    { returnDocument: "after" },
  );
  const updated =
    updateResult && "value" in updateResult
      ? updateResult.value
      : updateResult;

  if (!updated) return { stale: true };

  return { booking: await getOwnerRentalById(database, authUser, id) };
};
