/**
 * Scheduled transition from `confirmed` to `completed`.
 *
 * A rental is complete once its date-only `endDate` (YYYY-MM-DD) has passed.
 * The comparison uses the end of that UTC day, so a rental ending today stays
 * active until 23:59:59.999 UTC. The job is idempotent: only confirmed rows are
 * selected, and a `completedAt` timestamp is written for auditing.
 */
import cron from "node-cron";

const PURCHASE_COLLECTION = "purchases";
const DEFAULT_CRON_EXPRESSION = "*/5 * * * *";
const CONFIRMED_STATUS_VALUES = [
  null,
  "",
  "confirmed",
  "Confirmed",
  "CONFIRMED",
];

/** Returns the instant at which a rental end date is considered over. */
const getRentalEndInstant = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!dateOnly) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const year = Number(dateOnly[1]);
  const month = Number(dateOnly[2]);
  const day = Number(dateOnly[3]);
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  // Reject impossible values such as 2026-02-31, which Date.UTC rolls over.
  if (
    end.getUTCFullYear() !== year ||
    end.getUTCMonth() !== month - 1 ||
    end.getUTCDate() !== day
  ) {
    return null;
  }

  return end;
};

export const completeExpiredBookings = async (database, now = new Date()) => {
  const purchases = database.collection(PURCHASE_COLLECTION);

  const candidates = await purchases
    .find({
      status: { $in: CONFIRMED_STATUS_VALUES },
      endDate: { $exists: true, $nin: [null, ""] },
      completedAt: { $in: [null] },
    })
    .project({ status: 1, endDate: 1 })
    .toArray();

  const expiredIds = candidates
    .filter((booking) => {
      const end = getRentalEndInstant(booking.endDate);
      return end !== null && end.getTime() < now.getTime();
    })
    .map((booking) => booking._id);

  if (expiredIds.length === 0) {
    return { checked: candidates.length, updated: 0 };
  }

  // Re-check the status while updating so a simultaneous owner/admin decision
  // cannot be overwritten by the scheduled job.
  const result = await purchases.updateMany(
    {
      _id: { $in: expiredIds },
      status: { $in: CONFIRMED_STATUS_VALUES },
    },
    {
      $set: {
        status: "completed",
        completedAt: now,
        completedBy: "cron",
        updatedAt: now,
      },
    },
  );

  return { checked: candidates.length, updated: result.modifiedCount };
};

export const startBookingCompletionCron = async (database) => {
  const expression =
    process.env.BOOKING_COMPLETION_CRON ?? DEFAULT_CRON_EXPRESSION;

  if (!cron.validate(expression)) {
    console.error(
      `Invalid BOOKING_COMPLETION_CRON expression: ${expression}. Job was not started.`,
    );
    return null;
  }

  // Catch rentals that expired while the server was offline.
  try {
    const initial = await completeExpiredBookings(database);
    if (initial.updated > 0) {
      console.log(
        `Booking completion startup check updated ${initial.updated} rental(s).`,
      );
    }
  } catch (error) {
    console.error("Booking completion startup check failed", error);
  }

  const task = cron.schedule(
    expression,
    async () => {
      try {
        const result = await completeExpiredBookings(database);
        if (result.updated > 0) {
          console.log(
            `Booking completion cron updated ${result.updated} rental(s).`,
          );
        }
      } catch (error) {
        console.error("Booking completion cron failed", error);
      }
    },
    {
      name: "booking-completion",
      noOverlap: true,
    },
  );

  console.log(`Booking completion cron scheduled: ${expression}`);
  return task;
};
