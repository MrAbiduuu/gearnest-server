import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import {
  getAdminAnalyticsOverview,
  getAdminMonthlyBookings,
  getAdminMonthlyRevenue,
  parseAnalyticsYear,
} from "./analytics.js";
import {
  getAdminBookings,
  isBookingStatus,
  parseBookingsQuery,
  updateAdminBookingStatus,
} from "./bookings.js";
import {
  getCustomerBookingAnalytics,
  getCustomerBookingStatus,
  getCustomerDashboardOverview,
  getCustomerRecentBookings,
  parseBookingPeriod,
  parseRecentBookingLimit,
} from "./customer-dashboard.js";
import {
  equipmentStatusExpression,
  isEquipmentStatus,
  updateEquipmentStatus,
} from "./equipment-moderation.js";
import {
  getOwnerDashboardOverview,
  getOwnerMonthlyBookings,
  getOwnerMonthlyRevenue,
} from "./owner-dashboard.js";
import {
  getOwnerRentalStats,
  getOwnerRentals,
  updateOwnerRentalStatus,
} from "./owner-rentals.js";
import { startBookingCompletionCron } from "./booking-completion-cron.js";

const app = express();
const port = process.env.PORT;

const allowedOrigins = (process.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      // Server-to-server calls (Next.js route handlers) send no Origin header.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  }),
);

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("gearnestdb");
const users = database.collection("user");
const equipments = database.collection("equipments");

// Marks confirmed rentals as completed once their end date has passed.
await startBookingCompletionCron(database);

// The Next.js app signs short-lived JWTs with the shared Better Auth secret
// and JWKS. Express uses the same issuer/audience so it can verify them here.
const jwtIssuer = process.env.JWT_ISSUER ?? "gearnest";
const jwtAudience = process.env.JWT_AUDIENCE ?? "gearnest-api";

const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(database, { client: connectedClient }),
  trustedOrigins: allowedOrigins,
  plugins: [
    jwt({
      jwt: {
        issuer: jwtIssuer,
        audience: jwtAudience,
      },
    }),
  ],
  user: {
    additionalFields: {
      role: {
        type: ["customer", "admin", "owner"],
        required: false,
        defaultValue: "customer",
      },
      phone: { type: "string", required: false, defaultValue: "" },
      address: { type: "string", required: false, defaultValue: "" },
    },
  },
});

const USER_ROLES = ["customer", "owner", "admin"];
const safeUserProjection = {
  _id: 1,
  name: 1,
  email: 1,
  emailVerified: 1,
  image: 1,
  createdAt: 1,
  updatedAt: 1,
  role: 1,
  address: 1,
  phone: 1,
};

const getBearerToken = (req) => {
  const authorization = req.get("authorization");
  if (!authorization) return null;

  const [scheme, ...parts] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;

  return parts.join(" ").trim() || null;
};

const normalizeRole = (role) => (USER_ROLES.includes(role) ? role : "customer");

const toIsoString = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const serializeUser = (user) => ({
  id: user._id?.toString() ?? "",
  name: user.name ?? "",
  email: user.email ?? "",
  emailVerified: user.emailVerified === true,
  image:
    typeof user.image === "string" && user.image.trim() ? user.image : null,
  role: normalizeRole(user.role),
  address: user.address ?? "",
  phone: user.phone ?? "",
  createdAt: toIsoString(user.createdAt),
  updatedAt: toIsoString(user.updatedAt),
});

const sendError = (res, status, message) =>
  res.status(status).send({ success: false, message });

/**
 * Verifies the short-lived Better Auth JWT sent as `Authorization: Bearer ...`.
 * Signature, issuer, audience and expiry are checked by Better Auth using the
 * shared JWKS. The role is read from the database on every request, so a
 * stale token cannot keep privileges after a role change or revocation.
 */
const verifyToken = async (req, res, next) => {
  if (!process.env.BETTER_AUTH_SECRET) {
    return sendError(res, 500, "Server authentication is not configured.");
  }

  const token = getBearerToken(req);
  if (!token) {
    return sendError(res, 401, "You must be signed in.");
  }

  try {
    const { payload } = await auth.api.verifyJWT({ body: { token } });
    const subject = String(payload?.sub ?? "");
    if (!ObjectId.isValid(subject)) {
      return sendError(res, 401, "Your token is invalid or has expired.");
    }

    const currentUser = await users.findOne(
      { _id: new ObjectId(subject) },
      { projection: safeUserProjection },
    );

    if (!currentUser) {
      return sendError(res, 401, "Your account no longer exists.");
    }

    req.authUser = serializeUser(currentUser);
    return next();
  } catch (error) {
    console.error("Could not verify JWT", error);
    return sendError(res, 401, "Your token is invalid or has expired.");
  }
};

const verifyAdmin = (req, res, next) => {
  if (req.authUser?.role !== "admin") {
    return sendError(res, 403, "Admin access required.");
  }
  return next();
};

const verifyOwner = (req, res, next) => {
  if (req.authUser?.role !== "owner") {
    return sendError(res, 403, "Owner access required.");
  }
  return next();
};

const verifyCustomer = (req, res, next) => {
  if (req.authUser?.role !== "customer") {
    return sendError(res, 403, "Customer access required.");
  }
  return next();
};

const PRIVATE_EQUIPMENT_STATUSES = ["all", "pending", "rejected"];

/**
 * The public catalog only exposes approved listings. Owner/admin moderation
 * views (status=all|pending|rejected) require a verified token.
 */
const verifyEquipmentListAccess = (req, res, next) => {
  const status =
    typeof req.query.status === "string"
      ? req.query.status.trim().toLowerCase()
      : "approved";

  req.equipmentStatusFilter = status;

  if (!PRIVATE_EQUIPMENT_STATUSES.includes(status)) {
    return next();
  }

  return verifyToken(req, res, () => {
    if (req.authUser?.role !== "owner" && req.authUser?.role !== "admin") {
      return sendError(res, 403, "Owner or admin access required.");
    }
    return next();
  });
};

/** Owners may only change or remove listings that belong to their account. */
const verifyEquipmentOwnership = async (req, res, next) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return sendError(res, 400, "Invalid equipment ID.");
  }

  try {
    const equipment = await equipments.findOne(
      { _id: new ObjectId(id) },
      { projection: { owner: 1 } },
    );

    if (!equipment) {
      return sendError(res, 404, "Equipment not found.");
    }

    const ownerEmail = String(equipment.owner?.email ?? "")
      .trim()
      .toLowerCase();
    const userEmail = String(req.authUser?.email ?? "").trim().toLowerCase();

    if (!ownerEmail || ownerEmail !== userEmail) {
      return sendError(res, 403, "You can only manage your own equipment.");
    }

    return next();
  } catch (error) {
    console.error("Could not verify equipment ownership", error);
    return sendError(res, 500, "Could not verify equipment ownership.");
  }
};

/** Reusable chain for owner-scoped equipment mutations. */
const verifyOwnedEquipment = [verifyToken, verifyOwner, verifyEquipmentOwnership];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * GET /users - admin-only, searchable, filterable, paginated user list.
 * Query params: role=all|customer|owner|admin, search=<text>, page, limit.
 */
app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const requestedRole =
      typeof req.query.role === "string"
        ? req.query.role.trim().toLowerCase()
        : "all";

    if (!["all", ...USER_ROLES].includes(requestedRole)) {
      return sendError(res, 400, "Invalid role filter.");
    }

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 10),
    );

    const query = {};
    if (requestedRole !== "all") query.role = requestedRole;
    if (search) {
      const pattern = escapeRegex(search);
      query.$or = [
        { name: { $regex: pattern, $options: "i" } },
        { email: { $regex: pattern, $options: "i" } },
      ];
    }

    const [matchedUsers, filteredTotal, totalRegisteredUsers, roleGroups] =
      await Promise.all([
        users
          .find(query, { projection: safeUserProjection })
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        users.countDocuments(query),
        users.countDocuments({}),
        users
          .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
          .toArray(),
      ]);

    const roleCounts = {
      all: totalRegisteredUsers,
      customer: 0,
      owner: 0,
      admin: 0,
    };
    for (const group of roleGroups) {
      const role = normalizeRole(group._id);
      roleCounts[role] = (roleCounts[role] ?? 0) + group.count;
    }

    return res.status(200).send({
      success: true,
      message: "Users retrieved successfully",
      data: {
        users: matchedUsers.map(serializeUser),
        totalUsers: filteredTotal,
        totalRegisteredUsers,
        roleCounts,
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(filteredTotal / limit)),
        limit,
      },
    });
  } catch (error) {
    console.error("Could not retrieve users", error);
    return sendError(res, 500, "Could not retrieve users.");
  }
});

/** PATCH /users/:id/role - admin-only role assignment. */
app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return sendError(res, 400, "Invalid user ID.");
    }

    const requestedRole =
      typeof req.body?.role === "string"
        ? req.body.role.trim().toLowerCase()
        : "";
    if (!USER_ROLES.includes(requestedRole)) {
      return sendError(res, 400, "Role must be customer, owner, or admin.");
    }

    const targetId = new ObjectId(id);
    const target = await users.findOne(
      { _id: targetId },
      { projection: safeUserProjection },
    );
    if (!target) {
      return sendError(res, 404, "User not found.");
    }

    const currentRole = normalizeRole(target.role);
    if (currentRole === requestedRole) {
      return res.status(200).send({
        success: true,
        message: `User already has the ${requestedRole} role.`,
        data: serializeUser(target),
      });
    }

    if (id === req.authUser.id && requestedRole !== "admin") {
      return sendError(res, 403, "You cannot demote your own account.");
    }

    if (currentRole === "admin" && requestedRole !== "admin") {
      const adminCount = await users.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        return sendError(res, 409, "Cannot demote the last administrator.");
      }
    }

    await users.updateOne(
      { _id: targetId },
      { $set: { role: requestedRole, updatedAt: new Date() } },
    );

    const updated = await users.findOne(
      { _id: targetId },
      { projection: safeUserProjection },
    );

    return res.status(200).send({
      success: true,
      message: "User role updated successfully.",
      data: serializeUser(updated),
    });
  } catch (error) {
    console.error("Could not update user role", error);
    return sendError(res, 500, "Could not update user role.");
  }
});

/** DELETE /users/:id - admin-only account deletion with auth cleanup. */
app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return sendError(res, 400, "Invalid user ID.");
    }
    if (id === req.authUser.id) {
      return sendError(res, 403, "You cannot delete your own account.");
    }

    const targetId = new ObjectId(id);
    const target = await users.findOne(
      { _id: targetId },
      { projection: safeUserProjection },
    );
    if (!target) {
      return sendError(res, 404, "User not found.");
    }

    if (normalizeRole(target.role) === "admin") {
      const adminCount = await users.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        return sendError(res, 409, "Cannot delete the last administrator.");
      }
    }

    const deleted = await users.deleteOne({ _id: targetId });
    if (deleted.deletedCount === 0) {
      return sendError(res, 404, "User not found.");
    }

    // Better Auth keeps sessions/accounts/verification in separate collections.
    // userId is an ObjectId in session/account and may be a string elsewhere.
    const userIds = [targetId, id];
    const cleanup = await Promise.allSettled([
      database.collection("session").deleteMany({ userId: { $in: userIds } }),
      database.collection("account").deleteMany({ userId: { $in: userIds } }),
      database
        .collection("verification")
        .deleteMany({ userId: { $in: userIds } }),
    ]);

    const cleanupFailed = cleanup.some(
      (result) => result.status === "rejected",
    );
    if (cleanupFailed) {
      console.error(
        "Some authentication records could not be removed",
        cleanup.filter((result) => result.status === "rejected"),
      );
    }

    return res.status(200).send({
      success: true,
      message: cleanupFailed
        ? "User deleted, but some related authentication records could not be removed."
        : "User and related authentication records deleted successfully.",
      data: { id },
    });
  } catch (error) {
    console.error("Could not delete user", error);
    return sendError(res, 500, "Could not delete user.");
  }
});

/**
 * GET /admin/analytics - admin-only aggregated platform overview.
 * All metrics, including the latest bookings, come from MongoDB.
 */
app.get("/admin/analytics", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const data = await getAdminAnalyticsOverview(database);

    return res.status(200).send({
      success: true,
      message: "Platform analytics retrieved successfully",
      data,
    });
  } catch (error) {
    console.error("Could not retrieve admin analytics", error);
    return sendError(res, 500, "Could not retrieve platform analytics.");
  }
});

/**
 * GET /admin/analytics/monthly-bookings?year=2026 - admin-only monthly chart
 * data. All 12 months are returned; months without bookings stay at zero.
 */
app.get(
  "/admin/analytics/monthly-bookings",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const year = parseAnalyticsYear(req.query.year);
    if (year === null) {
      return sendError(res, 400, "Provide a valid booking year.");
    }

    try {
      const data = await getAdminMonthlyBookings(database, year);

      return res.status(200).send({
        success: true,
        message: "Monthly booking statistics retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve monthly booking statistics", error);
      return sendError(
        res,
        500,
        "Could not retrieve monthly booking statistics.",
      );
    }
  },
);

/**
 * GET /admin/analytics/monthly-revenue?year=2026 - admin-only gross paid
 * rental volume by calendar month. All 12 months are returned, with zero
 * values for months without successful payments.
 */
app.get(
  "/admin/analytics/monthly-revenue",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const year = parseAnalyticsYear(req.query.year);
    if (year === null) {
      return sendError(res, 400, "Provide a valid revenue year.");
    }

    try {
      const data = await getAdminMonthlyRevenue(database, year);

      return res.status(200).send({
        success: true,
        message: "Monthly revenue statistics retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve monthly revenue statistics", error);
      return sendError(
        res,
        500,
        "Could not retrieve monthly revenue statistics.",
      );
    }
  },
);

/**
 * GET /admin/bookings - admin-only, searchable, paginated booking record.
 * Query params: status=all|pending|confirmed|completed|cancelled, search, page, limit,
 * sort=newest|oldest.
 */
app.get("/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  const options = parseBookingsQuery(req.query);
  if (!options) {
    return sendError(res, 400, "Invalid booking search parameters.");
  }

  try {
    const data = await getAdminBookings(database, options);

    return res.status(200).send({
      success: true,
      message: "Bookings retrieved successfully",
      data,
    });
  } catch (error) {
    console.error("Could not retrieve admin bookings", error);
    return sendError(res, 500, "Could not retrieve bookings.");
  }
});

/** PATCH /admin/bookings/:id/status - admin-only booking status moderation. */
app.patch(
  "/admin/bookings/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const requestedStatus = req.body?.status;
    if (!isBookingStatus(requestedStatus)) {
      return sendError(res, 400, "Invalid booking status.");
    }

    try {
      const result = await updateAdminBookingStatus(
        database,
        req.params.id,
        requestedStatus,
      );

      if (result.invalidRequest) {
        return sendError(res, 400, "Invalid booking ID or status.");
      }
      if (result.notFound) {
        return sendError(res, 404, "Booking not found.");
      }
      if (result.invalidTransition) {
        return sendError(
          res,
          409,
          `Cannot change a ${result.current} booking to ${requestedStatus}.`,
        );
      }

      return res.status(200).send({
        success: true,
        message: result.unchanged
          ? "Booking status is already up to date."
          : "Booking status updated successfully",
        data: result.booking,
      });
    } catch (error) {
      console.error("Could not update booking status", error);
      return sendError(res, 500, "Could not update booking status.");
    }
  },
);

/**
 * GET /customer/dashboard/overview - customer-only dashboard metrics. The
 * customer is resolved from the verified session; no customer ID is accepted
 * from the request.
 */
app.get(
  "/customer/dashboard/overview",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const data = await getCustomerDashboardOverview(database, req.authUser);
      return res.status(200).send({
        success: true,
        message: "Customer dashboard retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve customer dashboard", error);
      return sendError(res, 500, "Could not retrieve your dashboard.");
    }
  },
);

/**
 * GET /customer/dashboard/booking-status - customer-only status counts using
 * the three real booking statuses.
 */
app.get(
  "/customer/dashboard/booking-status",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const data = await getCustomerBookingStatus(database, req.authUser);
      return res.status(200).send({
        success: true,
        message: "Customer booking status retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve customer booking status", error);
      return sendError(res, 500, "Could not retrieve your booking status.");
    }
  },
);

/**
 * GET /customer/dashboard/booking-analytics?period=6months - customer-only
 * monthly booking activity. Supported periods are 3months, 6months, 12months.
 */
app.get(
  "/customer/dashboard/booking-analytics",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    const requestedPeriod =
      typeof req.query.period === "string" && req.query.period.trim()
        ? req.query.period.trim().toLowerCase()
        : "6months";
    const months = parseBookingPeriod(requestedPeriod);
    if (months === null) {
      return sendError(res, 400, "Provide a valid booking analytics period.");
    }

    try {
      const data = await getCustomerBookingAnalytics(
        database,
        req.authUser,
        months,
      );
      return res.status(200).send({
        success: true,
        message: "Customer booking analytics retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve customer booking analytics", error);
      return sendError(res, 500, "Could not retrieve your booking analytics.");
    }
  },
);

/**
 * GET /customer/dashboard/recent-bookings?limit=3 - customer-only latest
 * bookings enriched with the associated equipment details.
 */
app.get(
  "/customer/dashboard/recent-bookings",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    if (
      req.query.limit !== undefined &&
      (typeof req.query.limit !== "string" ||
        !/^\d+$/.test(req.query.limit.trim()))
    ) {
      return sendError(res, 400, "Provide a valid recent booking limit.");
    }

    try {
      const data = await getCustomerRecentBookings(
        database,
        req.authUser,
        parseRecentBookingLimit(req.query.limit),
      );
      return res.status(200).send({
        success: true,
        message: "Customer recent bookings retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve customer recent bookings", error);
      return sendError(res, 500, "Could not retrieve your recent bookings.");
    }
  },
);

/**
 * GET /owner/dashboard/overview - owner-only dashboard data. The owner is
 * resolved from the verified session; no client-supplied owner ID is accepted.
 */
app.get(
  "/owner/dashboard/overview",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const data = await getOwnerDashboardOverview(database, req.authUser);
      return res.status(200).send({
        success: true,
        message: "Owner dashboard retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve owner dashboard", error);
      return sendError(res, 500, "Could not retrieve your dashboard.");
    }
  },
);

/**
 * GET /owner/dashboard/revenue?year=2026 - owner-only monthly paid rental
 * volume. All 12 months are returned; months without payments remain zero.
 */
app.get(
  "/owner/dashboard/revenue",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    const year = parseAnalyticsYear(req.query.year);
    if (year === null) {
      return sendError(res, 400, "Provide a valid revenue year.");
    }

    try {
      const data = await getOwnerMonthlyRevenue(database, req.authUser, year);
      return res.status(200).send({
        success: true,
        message: "Owner revenue analytics retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve owner revenue analytics", error);
      return sendError(
        res,
        500,
        "Could not retrieve your monthly revenue analytics.",
      );
    }
  },
);

/**
 * GET /owner/dashboard/monthly-bookings?year=2026 - owner-only monthly rental
 * request volume. All 12 months are returned; months without requests stay 0.
 */
app.get(
  "/owner/dashboard/monthly-bookings",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    const year = parseAnalyticsYear(req.query.year);
    if (year === null) {
      return sendError(res, 400, "Provide a valid booking year.");
    }

    try {
      const data = await getOwnerMonthlyBookings(database, req.authUser, year);
      return res.status(200).send({
        success: true,
        message: "Owner booking analytics retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve owner booking analytics", error);
      return sendError(
        res,
        500,
        "Could not retrieve your monthly booking analytics.",
      );
    }
  },
);

/**
 * GET /owner/rentals - owner-only rental requests received for the owner's
 * equipment. Query params: status, search, page, limit, sort.
 */
app.get("/owner/rentals", verifyToken, verifyOwner, async (req, res) => {
  const options = parseBookingsQuery(req.query);
  if (!options) {
    return sendError(res, 400, "Invalid rental search parameters.");
  }

  try {
    const data = await getOwnerRentals(database, req.authUser, options);
    return res.status(200).send({
      success: true,
      message: "Rental requests retrieved successfully",
      data,
    });
  } catch (error) {
    console.error("Could not retrieve owner rentals", error);
    return sendError(res, 500, "Could not load your rental requests.");
  }
});

/** GET /owner/rentals/stats - owner-global rental counts. */
app.get(
  "/owner/rentals/stats",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const data = await getOwnerRentalStats(database, req.authUser);
      return res.status(200).send({
        success: true,
        message: "Rental statistics retrieved successfully",
        data,
      });
    } catch (error) {
      console.error("Could not retrieve owner rental statistics", error);
      return sendError(res, 500, "Could not load your rental statistics.");
    }
  },
);

/**
 * PATCH /owner/rentals/:id/status - owner approval/rejection for a pending
 * request, using the shared booking transition rules.
 */
app.patch(
  "/owner/rentals/:id/status",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    const requestedStatus = req.body?.status;
    if (!isBookingStatus(requestedStatus)) {
      return sendError(res, 400, "Invalid rental status.");
    }

    try {
      const result = await updateOwnerRentalStatus(
        database,
        req.authUser,
        req.params.id,
        requestedStatus,
      );

      if (result.invalidRequest) {
        return sendError(res, 400, "Invalid rental ID or status.");
      }
      if (result.notFound) {
        return sendError(res, 404, "Rental request not found.");
      }
      if (result.invalidTransition) {
        return sendError(
          res,
          409,
          `Cannot change a ${result.current} request to ${requestedStatus}.`,
        );
      }
      if (result.conflict) {
        return sendError(res, 409, result.detail ?? "This request is no longer available.");
      }
      if (result.stale) {
        return sendError(
          res,
          409,
          "This request was already updated. Refresh and try again.",
        );
      }

      return res.status(200).send({
        success: true,
        message: result.unchanged
          ? "Rental status is already up to date."
          : "Rental request updated successfully",
        data: result.booking,
      });
    } catch (error) {
      console.error("Could not update owner rental status", error);
      return sendError(res, 500, "Could not update this rental request.");
    }
  },
);

// Equipment related apis

/**
 * GET /equipments - approved listings by default. Admin/owner views request
 * `status=all` so pending submissions remain visible to the people who manage
 * them without exposing them on the public catalog.
 */
app.get("/equipments", verifyEquipmentListAccess, async (req, res) => {
  try {
    const requestedStatus = req.equipmentStatusFilter;

    if (
      !["all", "approved", "pending", "rejected"].includes(requestedStatus)
    ) {
      return sendError(res, 400, "Invalid equipment status filter.");
    }

    const pipeline = [
      { $addFields: { normalizedStatus: equipmentStatusExpression } },
    ];

    if (requestedStatus !== "all") {
      pipeline.push({ $match: { normalizedStatus: requestedStatus } });
    }

    pipeline.push({ $project: { normalizedStatus: 0 } });

    const result = await equipments.aggregate(pipeline).toArray();

    res.status(200).send({
      success: true,
      message: "Equipments retrieved successfully",
      data: result,
    });
  } catch (error) {
    console.error("Could not retrieve equipments", error);
    res.status(500).send({
      success: false,
      message: "Failed to retrieve equipments",
    });
  }
});

/**
 * PATCH /admin/equipments/:id/status - approve or reject a pending listing.
 */
app.patch(
  "/admin/equipments/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const requestedStatus = req.body?.status;
    if (!isEquipmentStatus(requestedStatus)) {
      return sendError(res, 400, "Invalid equipment status.");
    }

    try {
      const result = await updateEquipmentStatus(
        database,
        req.params.id,
        requestedStatus,
      );

      if (result.invalidRequest) {
        return sendError(res, 400, "Invalid equipment ID or status.");
      }
      if (result.notFound) {
        return sendError(res, 404, "Equipment not found.");
      }
      if (result.invalidTransition) {
        return sendError(
          res,
          409,
          `Cannot change a ${result.current} listing to ${requestedStatus}.`,
        );
      }

      return res.status(200).send({
        success: true,
        message: result.unchanged
          ? "Equipment status is already up to date."
          : `Equipment ${requestedStatus} successfully`,
        data: result.equipment,
      });
    } catch (error) {
      console.error("Could not update equipment status", error);
      return sendError(res, 500, "Could not update equipment status.");
    }
  },
);

// creating a new equipment listing (owners only)
app.post("/equipments", verifyToken, verifyOwner, async (req, res) => {
  try {
    const {
      name,
      category,
      description,
      rentalRate,
      rentalPeriod,
      availableStock,
      brand,
      model,
      condition,
      location,
      rentalTerms,
      imageUrls,
    } = req.body ?? {};

    const requiredFields = {
      name,
      category,
      description,
      rentalRate,
      rentalPeriod,
      availableStock,
      location,
    };

    const missingFields = Object.entries(requiredFields)
      .filter(
        ([, value]) => value === undefined || value === null || value === "",
      )
      .map(([field]) => field);

    if (missingFields.length > 0) {
      return res.status(400).send({
        success: false,
        message: `Missing required fields: ${missingFields.join(", ")}`,
      });
    }

    const parsedRentalRate = Number(rentalRate);
    const parsedStock = Number(availableStock);

    if (
      !Number.isFinite(parsedRentalRate) ||
      parsedRentalRate <= 0 ||
      !Number.isInteger(parsedStock) ||
      parsedStock < 1
    ) {
      return res.status(400).send({
        success: false,
        message:
          "Rental rate and available stock must be valid positive numbers.",
      });
    }

    const urls = Array.isArray(imageUrls)
      ? imageUrls.filter((url) => typeof url === "string" && url.trim() !== "")
      : [];

    const document = {
      name: String(name).trim(),
      shortDescription: String(description).trim().slice(0, 160),
      description: String(description).trim(),
      category: String(category).trim(),
      image: urls[0] ?? "",
      images: urls,
      brand: String(brand ?? "").trim(),
      model: String(model ?? "").trim(),
      condition: String(condition ?? "Good").trim(),
      availableStock: parsedStock,
      rentalRate: parsedRentalRate,
      rentalPeriod: String(rentalPeriod).trim(),
      location: String(location).trim(),
      rentalTerms: String(rentalTerms ?? "").trim(),
      status: "pending",
      // Ownership comes from the verified token, never from the request body.
      owner: {
        name: req.authUser.name,
        email: req.authUser.email,
        isVerified: req.authUser.emailVerified === true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await equipments.insertOne(document);

    res.status(201).send({
      success: true,
      message: "Equipment published successfully",
      data: { ...document, _id: result.insertedId.toString() },
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      success: false,
      message: "Failed to publish equipment",
    });
  }
});

// getting single equipments
app.get("/equipments/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const query = { _id: new ObjectId(id) };

    const result = await equipments.findOne(query);

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      success: false,
      message: "Something went wrong",
    });
  }
});

// updating an equipment listing (only the owner who published it)
app.patch("/equipments/:id", verifyOwnedEquipment, async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const query = { _id: new ObjectId(id) };
    const existing = await equipments.findOne(query);

    if (!existing) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    const body = req.body ?? {};
    const pick = (key, fallback = "") =>
      body[key] !== undefined ? body[key] : (existing[key] ?? fallback);

    const urls =
      body.imageUrls !== undefined
        ? Array.isArray(body.imageUrls)
          ? body.imageUrls.filter(
              (url) => typeof url === "string" && url.trim() !== "",
            )
          : []
        : Array.isArray(existing.images)
          ? existing.images
          : existing.image
            ? [existing.image]
            : [];

    const name = String(pick("name")).trim();
    const category = String(pick("category")).trim();
    const description = String(pick("description")).trim();
    const rentalRate = Number(pick("rentalRate"));
    const rentalPeriod = String(pick("rentalPeriod")).trim();
    const availableStock = Number(pick("availableStock"));
    const location = String(pick("location")).trim();

    if (!name || !category || !description || !rentalPeriod || !location) {
      return res.status(400).send({
        success: false,
        message: "Please complete all required fields.",
      });
    }

    if (
      !Number.isFinite(rentalRate) ||
      rentalRate <= 0 ||
      !Number.isInteger(availableStock) ||
      availableStock < 1
    ) {
      return res.status(400).send({
        success: false,
        message:
          "Rental rate and available stock must be valid positive numbers.",
      });
    }

    const update = {
      name,
      shortDescription: description.slice(0, 160),
      description,
      category,
      image: urls[0] ?? "",
      images: urls,
      brand: String(pick("brand")).trim(),
      model: String(pick("model")).trim(),
      condition: String(pick("condition", "Good")).trim(),
      availableStock,
      rentalRate,
      rentalPeriod,
      location,
      rentalTerms: String(pick("rentalTerms")).trim(),
      status: existing.status ?? "pending",
      owner: existing.owner ?? {
        name: String(body.owner?.name ?? "").trim(),
        email: String(body.owner?.email ?? "").trim(),
        isVerified: body.owner?.isVerified ?? true,
      },
      updatedAt: new Date(),
    };

    await equipments.updateOne(query, { $set: update });
    const updated = await equipments.findOne(query);

    res.status(200).send({
      success: true,
      message: "Equipment updated successfully",
      data: { ...updated, _id: id },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to update equipment",
    });
  }
});

// deleting an equipment listing (only the owner who published it)
app.delete("/equipments/:id", verifyOwnedEquipment, async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const result = await equipments.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).send({
      success: true,
      message: "Equipment deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to delete equipment",
    });
  }
});

app.get("/", (req, res) => {
  res.send({ message: "Hello World!" });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
