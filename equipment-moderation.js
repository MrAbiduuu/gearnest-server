/** Admin moderation helpers for owner-submitted equipment listings. */
import { ObjectId } from "mongodb";

const EQUIPMENT_COLLECTION = "equipments";

export const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"];

const ALLOWED_TRANSITIONS = {
  pending: ["approved", "rejected"],
  approved: ["rejected"],
  rejected: ["approved"],
};

export const isEquipmentStatus = (value) =>
  EQUIPMENT_STATUSES.includes(String(value ?? "").toLowerCase());

export const getAllowedEquipmentTransitions = (status) =>
  ALLOWED_TRANSITIONS[String(status ?? "").toLowerCase()] ?? [];

/** Missing/unknown legacy statuses are treated as live approved listings. */
export const equipmentStatusExpression = {
  $switch: {
    branches: [
      {
        case: {
          $eq: [
            {
              $toLower: {
                $convert: {
                  input: { $ifNull: ["$status", ""] },
                  to: "string",
                  onError: "",
                  onNull: "",
                },
              },
            },
            "pending",
          ],
        },
        then: "pending",
      },
      {
        case: {
          $eq: [
            {
              $toLower: {
                $convert: {
                  input: { $ifNull: ["$status", ""] },
                  to: "string",
                  onError: "",
                  onNull: "",
                },
              },
            },
            "rejected",
          ],
        },
        then: "rejected",
      },
    ],
    default: "approved",
  },
};

const serializeEquipment = (document) => ({
  ...document,
  _id: document?._id?.toString() ?? "",
});

/**
 * Returns { notFound } / { invalidTransition } / { equipment, unchanged }.
 */
export const updateEquipmentStatus = async (database, id, requestedStatus) => {
  if (!ObjectId.isValid(id) || !isEquipmentStatus(requestedStatus)) {
    return { invalidRequest: true };
  }

  const objectId = new ObjectId(id);
  const status = requestedStatus.toLowerCase();
  const existing = await database
    .collection(EQUIPMENT_COLLECTION)
    .findOne({ _id: objectId }, { projection: { status: 1 } });

  if (!existing) return { notFound: true };

  const current =
    typeof existing.status === "string" ? existing.status.toLowerCase() : "approved";
  const normalizedCurrent = isEquipmentStatus(current) ? current : "approved";

  if (normalizedCurrent === status) {
    const unchanged = await database
      .collection(EQUIPMENT_COLLECTION)
      .findOne({ _id: objectId });
    return { equipment: serializeEquipment(unchanged), unchanged: true };
  }

  if (!getAllowedEquipmentTransitions(normalizedCurrent).includes(status)) {
    return { invalidTransition: true, current: normalizedCurrent };
  }

  await database
    .collection(EQUIPMENT_COLLECTION)
    .updateOne({ _id: objectId }, { $set: { status } });

  const updated = await database
    .collection(EQUIPMENT_COLLECTION)
    .findOne({ _id: objectId });

  return { equipment: serializeEquipment(updated) };
};
